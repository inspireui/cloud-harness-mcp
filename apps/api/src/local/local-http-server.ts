import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createCloudHarnessServer } from '../mcp-server.js';
import { preAuthRequestLimits, principalRequestLimits, requestSecurity } from '../request-security.js';
import { MultiLocalWorkspaceBackend, type LocalWorkspacePool } from './multi-local-workspace-backend.js';
import type { LocalHttpSettings } from './local-workspace-registry.js';

const LOCAL_CLIENT_ID = 'local-owner';

type AuthenticatedRequest = Request & { auth?: AuthInfo };

/** Reads the owner bearer token the same way the remote API does: `MCP_BEARER_TOKEN` or `MCP_BEARER_TOKEN_FILE`. */
export function readLocalBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.MCP_BEARER_TOKEN_FILE;
  const token = file ? readFileSync(file, 'utf8').trim() : (env.MCP_BEARER_TOKEN ?? '');
  if (token.length < 32 || token.length > 512 || token.startsWith('change-me')) {
    throw new Error('local HTTP mode requires MCP_BEARER_TOKEN (or MCP_BEARER_TOKEN_FILE) with 32-512 characters and no placeholder value');
  }
  return token;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** The request's bearer token when it is the owner token, compared in constant time. */
function ownerToken(expected: string): (request: Request) => string | undefined {
  const expectedDigest = digest(expected);
  return (request) => {
    const authorization = request.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    // Comparing fixed-length digests keeps the check constant-time regardless of token length.
    return token && timingSafeEqual(digest(token), expectedDigest) ? token : undefined;
  };
}

function localBearerAuth(expected: string) {
  const owner = ownerToken(expected);
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const token = owner(request);
    if (!token) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    request.auth = { token, clientId: LOCAL_CLIENT_ID, scopes: [] };
    next();
  };
}

/**
 * Serves the operator-registered local workspaces over authenticated Streamable HTTP. It never
 * creates a runner client: these persistent host directories are executed in place by the same
 * local backends as stdio mode. Each request gets its own router with `explicit` selection, so no
 * active-workspace default is shared between concurrent clients.
 */
export function createLocalHttpApp(pool: LocalWorkspacePool, settings: LocalHttpSettings, bearerToken: string): { app: Express; close: () => Promise<void> } {
  const security = {
    publicHosts: ['localhost', '127.0.0.1', '::1', ...settings.publicHosts],
    allowedOrigins: settings.allowedOrigins
  };
  const mcpHandler = createMcpHandler(
    () => createCloudHarnessServer(new MultiLocalWorkspaceBackend(pool, 'explicit')),
    { legacy: 'stateless', responseMode: 'auto' }
  );
  const handler = toNodeHandler(mcpHandler);
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  // The configured limits (`http.limits`) apply to the single local owner. Requests without the
  // owner token go through the remote API's fixed pre-auth window (1000/min, 32 in flight) before
  // they are refused, so raising the owner limits never raises what unauthenticated traffic gets,
  // and unauthenticated traffic never takes the owner's in-flight slots.
  const { requestsPerMinute, inFlight, maxBodyBytes } = settings.limits;
  const isOwner = ownerToken(bearerToken);
  const preAuth = preAuthRequestLimits();
  const unauthenticatedLimits = (request: Request, response: Response, next: NextFunction): void => {
    if (isOwner(request)) next();
    else preAuth(request, response, next);
  };
  app.use('/mcp', requestSecurity(security), unauthenticatedLimits, localBearerAuth(bearerToken), principalRequestLimits(1_000, { requestsPerMinute, inFlight }));
  app.use('/mcp', express.json({ limit: maxBodyBytes, strict: true }));
  app.all('/mcp', async (request: Request, response: Response) => {
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    await handler(request, response, request.body);
  });
  return { app, close: () => mcpHandler.close() };
}

/** True for addresses that only accept connections from this host. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}
