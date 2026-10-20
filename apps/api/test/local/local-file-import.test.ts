import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliOptions } from '../../src/cli-options.js';
import { createLocalHttpApp } from '../../src/local/local-http-server.js';
import { LocalWorkspaceBackend } from '../../src/local/local-workspace-backend.js';
import { loadLocalWorkspaceRegistry } from '../../src/local/local-workspace-registry.js';
import { LocalWorkspacePool, MultiLocalWorkspaceBackend } from '../../src/local/multi-local-workspace-backend.js';
import { createCloudHarnessServer, RunnerOperationBackend } from '../../src/mcp-server.js';
import type { RunnerClient } from '../../src/runner-client.js';

const options: CliOptions = { transport: 'http', gitNetwork: false, gitPush: false, env: [], help: false, version: false };
const TOKEN = 'local-file-import-test-token-0123456789abcdef';
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);
const WS_ID = 'ws_local_import_test_0123456789';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** The JSON-RPC message of a JSON or single-event SSE response. */
async function rpc(response: Response): Promise<any> {
  const text = await response.text();
  const data = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '';
  return JSON.parse(data);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

type Data = { dir: string; imported: number; failed: number; files: Array<Record<string, any>> };

describe('files_import (local)', () => {
  let base: string;
  let root: string;
  let fileServer: string;
  let backend: LocalWorkspaceBackend;
  const servers: Server[] = [];
  const pools: LocalWorkspacePool[] = [];
  const requests: string[] = [];

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ch-file-import-')));
    root = join(base, 'app');
    await mkdir(root);
    const files = createServer((request: IncomingMessage, response: ServerResponse) => {
      requests.push(request.url ?? '');
      const url = new URL(request.url ?? '/', 'http://x');
      if (url.pathname === '/png') { response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG); return; }
      if (url.pathname === '/jpeg') { response.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG); return; }
      if (url.pathname === '/text') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('hello'); return; }
      if (url.pathname === '/big') {
        // No Content-Length: the cap must hold while streaming.
        response.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
        for (let i = 0; i < 8; i += 1) response.write(Buffer.alloc(1_024, i));
        response.end();
        return;
      }
      if (url.pathname === '/declared-big') { response.writeHead(200, { 'content-length': String(1 << 20) }).end(); return; }
      if (url.pathname === '/redirect') { response.writeHead(302, { location: '/png' }).end(); return; }
      if (url.pathname === '/loop') { response.writeHead(302, { location: '/loop' }).end(); return; }
      if (url.pathname === '/to-insecure') { response.writeHead(302, { location: 'http://example.com/x.png' }).end(); return; }
      response.writeHead(403).end();
    });
    servers.push(files);
    fileServer = await listen(files);
    backend = new LocalWorkspaceBackend(root, options, undefined, WS_ID);
    backend.fileImport = { maxFileBytes: 4_096, allowLoopbackHttp: true };
    requests.length = 0;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    for (const pool of pools.splice(0)) await pool.close();
    await backend.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  const ref = (path: string, extra: Record<string, unknown> = {}) => ({ download_url: `${fileServer}${path}`, file_id: `file-${path.slice(1)}`, ...extra });
  const run = (input: Record<string, unknown>) => backend.callBackendTool('files_import', { workspaceId: WS_ID, ...input });

  it('downloads files, follows redirects, sniffs the MIME type, and reports hashes', async () => {
    const result = await run({ dir: 'assets/shots', files: [ref('/png', { file_name: 'Hero Shot.png' }), ref('/jpeg', { mime_type: 'image/jpeg' }), ref('/redirect', { file_name: 'moved' })] });
    expect(result.ok).toBe(true);
    const data = result.data as Data;
    expect(data).toMatchObject({ dir: 'assets/shots', imported: 3, failed: 0 });
    expect(data.files[0]).toEqual({ index: 0, file_id: 'file-png', ok: true, path: 'assets/shots/Hero_Shot.png', bytes: PNG.length, sha256: sha256(PNG), mime: 'image/png' });
    expect(data.files[1]).toMatchObject({ path: 'assets/shots/file-jpeg.jpg', bytes: JPEG.length, sha256: sha256(JPEG), mime: 'image/jpeg' });
    expect(data.files[2]).toMatchObject({ path: 'assets/shots/moved.png', mime: 'image/png' });
    expect(await readFile(join(root, 'assets/shots/Hero_Shot.png'))).toEqual(PNG);
    // No temporary file is left behind.
    expect((await readdir(join(root, 'assets/shots'))).sort()).toEqual(['Hero_Shot.png', 'file-jpeg.jpg', 'moved.png']);
  });

  it('accepts an absolute dir inside the root and explicit names', async () => {
    const result = await run({ dir: join(root, 'img'), files: [ref('/png'), ref('/text')], names: ['a.png', 'notes.txt'] });
    expect(result.ok).toBe(true);
    expect((result.data as Data).files.map((file) => [file.path, file.mime])).toEqual([['img/a.png', 'image/png'], ['img/notes.txt', 'text/plain']]);
  });

  it('enforces the size cap while streaming and from Content-Length, keeping the other files', async () => {
    const result = await run({ dir: 'out', files: [ref('/big'), ref('/declared-big'), ref('/png')] });
    expect(result.ok).toBe(true);
    const data = result.data as Data;
    expect(data).toMatchObject({ imported: 1, failed: 2 });
    expect(data.files[0]).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(data.files[1]).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(result.message).toContain('Imported 1 of 3 files');
    expect(await readdir(join(root, 'out'))).toEqual(['file-png.png']);
  });

  it('refuses non-https URLs, including on a redirect hop, and never echoes the URL', async () => {
    backend.fileImport = { maxFileBytes: 4_096, allowLoopbackHttp: false };
    const secretUrl = `${fileServer}/png?sig=SECRET-CAPABILITY`;
    const refused = await run({ dir: 'out', files: [{ download_url: secretUrl, file_id: 'f1' }, { download_url: 'ftp://example.com/a.png', file_id: 'f2' }, { download_url: 'not a url', file_id: 'f3' }] });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('INVALID_INPUT');
    expect((refused.data as Data).files.map((file) => file.error.code)).toEqual(['INSECURE_URL', 'INSECURE_URL', 'INVALID_URL']);
    expect(JSON.stringify(refused)).not.toContain('SECRET-CAPABILITY');
    expect(requests).toEqual([]);

    backend.fileImport = { maxFileBytes: 4_096, allowLoopbackHttp: true };
    const hop = await run({ dir: 'out', files: [ref('/to-insecure'), ref('/loop')] });
    expect((hop.data as Data).files.map((file) => file.error.code)).toEqual(['INSECURE_URL', 'TOO_MANY_REDIRECTS']);
    expect(requests.filter((url) => url === '/loop')).toHaveLength(6);
  });

  it('refuses a dir that escapes the workspace, lexically, absolutely, or through a symlink', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'link'));
    for (const dir of ['../outside', outside, 'link', 'link/nested', '/etc']) {
      const result = await run({ dir, files: [ref('/png')] });
      expect(result.ok, dir).toBe(false);
      expect(result.error?.code, dir).toBe('INVALID_INPUT');
      expect(result.message, dir).toContain('escapes workspace');
    }
    expect(await readdir(outside)).toEqual([]);
    expect(requests).toEqual([]);
    // A Node errno error (ENOTDIR through a dangling symlink) reports only its code, never the host path.
    await symlink(join(base, 'missing'), join(root, 'dang'));
    const notDir = await run({ dir: 'dang/sub', files: [ref('/png')] });
    expect(notDir.ok).toBe(false);
    expect(notDir.error?.code).toBe('INVALID_INPUT');
    expect(notDir.message).toMatch(/^dir cannot be created: E[A-Z]+$/);
    expect(JSON.stringify(notDir)).not.toContain(base);
    expect(requests).toEqual([]);
    const badName = await run({ dir: 'out', files: [ref('/png'), ref('/jpeg')], names: ['../x.png', 'ok.jpg'] });
    expect((badName.data as Data).files.map((file) => file.ok ? file.path : file.error.code)).toEqual(['INVALID_NAME', 'out/ok.jpg']);
  });

  it('keeps an existing file unless overwrite is true, and reports duplicate names in one call', async () => {
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'hero.png'), 'old');
    const kept = await run({ dir: 'out', files: [ref('/png')], names: ['hero.png'] });
    expect(kept.ok).toBe(false);
    expect(kept.error?.code).toBe('CONFLICT');
    expect((kept.data as Data).files[0]).toMatchObject({ error: { code: 'EXISTS' } });
    expect(await readFile(join(root, 'out', 'hero.png'), 'utf8')).toBe('old');
    // The clash is known from the name, so the URL is not spent; same for a file_name with an extension.
    const byFileName = await run({ dir: 'out', files: [ref('/jpeg', { file_name: 'hero.png' })] });
    expect((byFileName.data as Data).files[0]).toMatchObject({ error: { code: 'EXISTS' } });
    expect(requests).toEqual([]);

    const replaced = await run({ dir: 'out', files: [ref('/png')], names: ['hero.png'], overwrite: true });
    expect(replaced.ok).toBe(true);
    expect(await readFile(join(root, 'out', 'hero.png'))).toEqual(PNG);

    const duplicate = await run({ dir: 'out', files: [ref('/png'), ref('/jpeg')], names: ['same.png', 'same.png'] });
    expect((duplicate.data as Data).files.map((file) => file.ok ? 'ok' : file.error.code).sort()).toEqual(['DUPLICATE_NAME', 'ok']);
    expect((await readdir(join(root, 'out'))).sort()).toEqual(['hero.png', 'same.png']);
  });

  it('rejects names whose count does not match files', async () => {
    const result = await run({ dir: 'out', files: [ref('/png')], names: ['a.png', 'b.png'] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('one entry per file');
  });

  it('lists files_import over HTTP with openai/fileParams and the full FileRef schema, and imports through the multi-workspace router', async () => {
    await writeFile(join(base, 'workspaces.yaml'), `version: 1\nworkspaces:\n  app:\n    path: ${root}\nfileImport:\n  maxFileBytes: 2048\n`);
    const registry = await loadLocalWorkspaceRegistry(join(base, 'workspaces.yaml'));
    expect(registry.fileImport).toEqual({ maxFileBytes: 2_048 });
    const pool = new LocalWorkspacePool(registry.workspaces, options, undefined, undefined, { maxFileBytes: registry.fileImport.maxFileBytes, allowLoopbackHttp: true });
    pools.push(pool);
    const server = createServer(createLocalHttpApp(pool, registry.http, TOKEN).app);
    servers.push(server);
    const url = await listen(server);

    const listed = await fetch(`${url}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const body = await rpc(listed) as { result: { tools: Array<Record<string, any>> } };
    const tool = body.result.tools.find((entry) => entry.name === 'files_import');
    expect(tool?._meta).toEqual({ 'openai/fileParams': ['files'] });
    const fileRef = tool?.inputSchema.properties.files.items;
    expect(tool?.inputSchema.properties.files.type).toBe('array');
    expect(fileRef.type).toBe('object');
    for (const property of ['download_url', 'file_id', 'mime_type', 'file_name']) expect(fileRef.properties[property]?.type, property).toBe('string');
    expect([...fileRef.required].sort()).toEqual(['download_url', 'file_id']);
    expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(['dir', 'files']));

    const workspaceId = registry.workspaces[0]!.workspaceId;
    const call = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'files_import', arguments: { workspaceId, dir: 'in', files: [ref('/png'), ref('/big')] } } })
    });
    const called = await rpc(call) as { result: { structuredContent: { ok: boolean; data: Data } } };
    expect(called.result.structuredContent.ok).toBe(true);
    expect(called.result.structuredContent.data.files.map((file) => file.ok ? file.path : file.error.code)).toEqual(['in/file-png.png', 'TOO_LARGE']);

    // A client that sends null for the optional fields is treated as leaving them out.
    const nulls = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'files_import', arguments: { workspaceId, dir: 'in', files: [ref('/jpeg', { mime_type: null, file_name: null }), ref('/text', { mime_type: null })] } } })
    });
    const nulled = await rpc(nulls) as { result: { isError?: boolean; structuredContent: { ok: boolean; data: Data } } };
    expect(nulled.result.isError).not.toBe(true);
    expect(nulled.result.structuredContent.data.files.map((file) => file.ok ? file.path : file.error.code)).toEqual(['in/file-jpeg.jpg', 'in/file-text.txt']);

    const instructions = new MultiLocalWorkspaceBackend(pool, 'explicit').getInstructions();
    expect(instructions).toContain('call files_import with the image as a file; never paste base64');
  });

  it('is not offered by the remote server', async () => {
    const remote = createCloudHarnessServer(new RunnerOperationBackend({} as RunnerClient));
    const tools = (remote as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).not.toContain('files_import');
    expect(Object.keys(tools)).toContain('files_write');
  });
});
