import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliOptions } from '../../src/cli-options.js';
import { createLocalHttpApp } from '../../src/local/local-http-server.js';
import { loadLocalWorkspaceRegistry, type LocalWorkspaceRegistry } from '../../src/local/local-workspace-registry.js';
import { LocalWorkspacePool } from '../../src/local/multi-local-workspace-backend.js';
import { principalRequestLimits } from '../../src/request-security.js';

const options: CliOptions = { transport: 'http', gitNetwork: false, gitPush: false, env: [], help: false, version: false };
const TOKEN = 'local-http-limits-test-token-0123456789abcdef';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

describe('local HTTP limits', () => {
  let base: string;
  let pool: LocalWorkspacePool | undefined;
  const servers: Server[] = [];

  async function start(limits?: string): Promise<{ url: string; registry: LocalWorkspaceRegistry }> {
    const http = limits ? `http:\n  limits:\n${limits}` : '';
    await writeFile(join(base, 'workspaces.yaml'), `version: 1\nworkspaces:\n  app:\n    path: ${join(base, 'app')}\n${http}`);
    const registry = await loadLocalWorkspaceRegistry(join(base, 'workspaces.yaml'));
    pool = new LocalWorkspacePool(registry.workspaces, options);
    const server = createServer(createLocalHttpApp(pool, registry.http, TOKEN).app);
    servers.push(server);
    return { url: await listen(server), registry };
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ch-http-limits-')));
    await mkdir(join(base, 'app'));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    await pool?.close();
    await rm(base, { recursive: true, force: true });
  });

  it('applies the configured per-minute limit to the local owner', async () => {
    const { url } = await start('    requestsPerMinute: 2\n');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${url}/mcp`, { method: 'POST', headers, body: toolsList });
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses[2]).toBe(429);
  });

  it('accepts a body up to the configured maxBodyBytes and rejects a larger one', async () => {
    const { url } = await start('    maxBodyBytes: 65536\n');
    const padded = (size: number) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { pad: 'x'.repeat(size) } } });
    const small = await fetch(`${url}/mcp`, { method: 'POST', headers, body: padded(30_000) });
    await small.arrayBuffer();
    expect(small.status).toBe(200);
    const large = await fetch(`${url}/mcp`, { method: 'POST', headers, body: padded(100_000) });
    await large.arrayBuffer();
    expect(large.status).toBe(413);
  });

  it('defaults to 600 per minute, 32 in flight, and 4 MiB bodies', async () => {
    const { url, registry } = await start();
    expect(registry.http.limits).toEqual({ requestsPerMinute: 600, inFlight: 32, maxBodyBytes: 4_194_304 });
    // A 2 MiB request, above the remote API's 1 MiB, is accepted.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { pad: 'x'.repeat(2_097_152) } } });
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers, body });
    await response.arrayBuffer();
    expect(response.status).toBe(200);
  });

  it('keeps unauthenticated traffic in its own fixed pre-auth window, whatever the owner limits', async () => {
    const { url } = await start('    requestsPerMinute: 100000\n    inFlight: 1024\n');
    const anonymous = { ...headers, authorization: 'Bearer wrong-token' };
    let last = 0;
    for (let attempt = 0; attempt < 1_001; attempt += 1) {
      const response = await fetch(`${url}/mcp`, { method: 'POST', headers: anonymous, body: toolsList });
      await response.arrayBuffer();
      last = response.status;
    }
    // The 1001st unauthenticated request in a minute is refused, as with the default owner limits.
    expect(last).toBe(429);
    // The owner is not counted in that window and still gets through.
    const owner = await fetch(`${url}/mcp`, { method: 'POST', headers, body: toolsList });
    await owner.arrayBuffer();
    expect(owner.status).toBe(200);
  });

  it('keeps the remote per-principal default of 8 requests in flight', async () => {
    const app = express();
    const release: Array<() => void> = [];
    app.use((request: Request & { auth?: { clientId: string; token: string; scopes: string[] } }, _response, next) => {
      request.auth = { clientId: 'owner', token: 't', scopes: [] };
      next();
    });
    app.use(principalRequestLimits());
    app.get('/slow', (_request: Request, response: Response) => { release.push(() => response.end('ok')); });
    const server = createServer(app);
    servers.push(server);
    const url = await listen(server);
    const pending = Array.from({ length: 8 }, () => fetch(`${url}/slow`));
    while (release.length < 8) await new Promise((resolve) => setTimeout(resolve, 10));
    const ninth = await fetch(`${url}/slow`);
    expect(ninth.status).toBe(429);
    for (const done of release) done();
    await Promise.all((await Promise.all(pending)).map((response) => response.arrayBuffer()));
  });
});
