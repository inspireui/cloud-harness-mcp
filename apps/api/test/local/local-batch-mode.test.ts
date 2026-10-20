import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { OperationIdSchema, TOOL_SPECS, type RunnerOperation } from '@cloud-harness/contracts';
import type { CliOptions } from '../../src/cli-options.js';
import { createCloudHarnessServer } from '../../src/mcp-server.js';
import type { OperationBackend } from '../../src/operation-backend.js';
import { LocalWorkspaceBackend } from '../../src/local/local-workspace-backend.js';
import { loadLocalWorkspaceRegistry, type RegisteredLocalWorkspace } from '../../src/local/local-workspace-registry.js';
import { LocalWorkspacePool, MultiLocalWorkspaceBackend } from '../../src/local/multi-local-workspace-backend.js';

const options: CliOptions = { transport: 'stdio', gitNetwork: false, gitPush: false, env: [], help: false, version: false };

type OperationData = { operationId: string; status: string; result?: { output: string; exitCode?: number; truncated: boolean; target?: string } };
type TaskView = { id: string; status: string; exitCode?: number; startedAt?: string; endedAt?: string };

/** A pid that belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid!;
}

async function listTools(backend: OperationBackend): Promise<string[]> {
  const server = createCloudHarnessServer(backend);
  const client = new Client({ name: 'local-batch-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe('local batch mode', () => {
  let base: string;
  let stateDir: string;
  let workspaces: RegisteredLocalWorkspace[];
  let pool: LocalWorkspacePool;
  let router: MultiLocalWorkspaceBackend;
  const id = (name: string) => workspaces.find((w) => w.name === name)!.workspaceId;

  async function registry(names: string[]): Promise<RegisteredLocalWorkspace[]> {
    const lines = names.map((name) => `  ${name}:\n    path: ${join(base, name)}`);
    await writeFile(join(base, 'workspaces.yaml'), `version: 1\nworkspaces:\n${lines.join('\n')}\n`);
    return (await loadLocalWorkspaceRegistry(join(base, 'workspaces.yaml'))).workspaces;
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ch-batch-')));
    stateDir = join(base, 'state');
    for (const name of ['alpha', 'beta']) await mkdir(join(base, name));
    workspaces = await registry(['alpha', 'beta']);
    pool = new LocalWorkspacePool(workspaces, options, undefined, stateDir);
    router = new MultiLocalWorkspaceBackend(pool, 'explicit');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.close();
    await rm(base, { recursive: true, force: true });
  });

  describe('async exec_run and bash', () => {
    it('returns the remote operation handle shape and waits for the output and exit code', async () => {
      const started = await router.call('exec_run', { workspaceId: id('alpha'), command: 'sleep 0.3; echo done-$PWD', async: true, timeoutMs: 10_000 });
      expect(started).toMatchObject({ ok: true, message: 'Command started in background', data: { status: 'running' } });
      const operationId = (started.data as OperationData).operationId;
      expect(OperationIdSchema.safeParse(operationId).success).toBe(true);

      const running = await router.call('operation_status', { operationId });
      expect(running.ok).toBe(true);
      expect(running.data).toMatchObject({ operationId, status: 'running', kind: 'exec_run' });

      const waited = await router.call('operation_wait', { operationId, timeoutMs: 10_000 });
      expect(waited.ok).toBe(true);
      expect(waited.data).toMatchObject({ operationId, status: 'completed', result: { exitCode: 0, truncated: false } });
      expect((waited.data as OperationData).result!.output.trim()).toBe(`done-${join(base, 'alpha')}`);

      const finished = await router.call('operation_status', { operationId });
      expect(finished.data).toMatchObject({ status: 'completed', result: { exitCode: 0 } });
      expect((finished.data as { output: string }).output).toContain('done-');
    });

    it('starts bash in the background with the workspace target in its result', async () => {
      const started = await router.call('bash', { workspaceId: id('beta'), command: 'echo from-bash', async: true, target: 'workspace' });
      const operationId = (started.data as OperationData).operationId;
      const waited = await router.call('operation_wait', { operationId, timeoutMs: 10_000 });
      expect(waited.data).toMatchObject({ status: 'completed', result: { target: 'workspace' } });
      expect((waited.data as OperationData).result!.output).toContain('from-bash');
    });

    it('reports a non-zero exit as a failed operation with CONFLICT', async () => {
      const started = await router.call('exec_run', { workspaceId: id('alpha'), command: 'echo nope; exit 3', async: true });
      const waited = await router.call('operation_wait', { operationId: (started.data as OperationData).operationId, timeoutMs: 10_000 });
      expect(waited.ok).toBe(false);
      expect(waited.error?.code).toBe('CONFLICT');
      expect(waited.data).toMatchObject({ status: 'failed', result: { exitCode: 3 } });
    });

    it('times out a wait without stopping the command, then cancels it', async () => {
      const started = await router.call('exec_run', { workspaceId: id('alpha'), command: 'sleep 30', async: true, timeoutMs: 60_000 });
      const operationId = (started.data as OperationData).operationId;
      const waited = await router.call('operation_wait', { operationId, timeoutMs: 300 });
      expect(waited.ok).toBe(false);
      expect(waited.error).toMatchObject({ code: 'TIMEOUT', retryable: true });

      const cancelled = await router.call('operation_cancel', { operationId });
      expect(cancelled).toMatchObject({ ok: true, data: { operationId, status: 'cancelled' } });
      const after = await router.call('operation_status', { operationId });
      expect(after.ok).toBe(false);
      expect(after.data).toMatchObject({ status: 'cancelled' });
      expect(after.error?.code).toBe('CANCELLED');
    });

    it('reports a wait the client aborted as CANCELLED, not TIMEOUT, and leaves the command running', async () => {
      const started = await router.call('exec_run', { workspaceId: id('alpha'), command: 'sleep 30', async: true, timeoutMs: 60_000 });
      const operationId = (started.data as OperationData).operationId;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const waited = await router.call('operation_wait', { operationId, timeoutMs: 10_000 }, controller.signal);
      expect(waited.ok).toBe(false);
      expect(waited.error).toMatchObject({ code: 'CANCELLED', message: expect.stringContaining('aborted by the client') });
      expect((await router.call('operation_status', { operationId })).data).toMatchObject({ status: 'running' });
      await router.call('operation_cancel', { operationId });
    });

    it('keeps the newest maxOutputBytes of a long output and reports it truncated', async () => {
      const started = await router.call('exec_run', { workspaceId: id('alpha'), command: 'seq 1 5000', async: true, maxOutputBytes: 1024 });
      const operationId = (started.data as OperationData).operationId;
      const waited = await router.call('operation_wait', { operationId, timeoutMs: 10_000 });
      const result = (waited.data as OperationData).result!;
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
      expect(result.output.endsWith('5000\n')).toBe(true);

      // Without a cursor the envelope still says early output was dropped, and offers no cursor
      // because the whole kept tail fits in one page.
      const status = await router.call('operation_status', { operationId });
      expect(status.truncated).toBe(true);
      expect(status.cursor).toBeUndefined();
      expect((status.data as { result: { truncated: boolean } }).result.truncated).toBe(true);
    });

    it('marks an operation that outlives its timeoutMs as a TIMEOUT failure', async () => {
      const started = await router.call('exec_run', { workspaceId: id('alpha'), command: 'sleep 30', async: true, timeoutMs: 200 });
      const waited = await router.call('operation_wait', { operationId: (started.data as OperationData).operationId, timeoutMs: 10_000 });
      expect(waited.data).toMatchObject({ status: 'failed' });
      expect(waited.error?.code).toBe('TIMEOUT');
    });

    it('routes operation tools to the workspace that owns the handle, even with several roots and no default', async () => {
      const started = await router.call('exec_run', { workspaceId: id('beta'), command: 'pwd', async: true });
      const waited = await router.call('operation_wait', { operationId: (started.data as OperationData).operationId, timeoutMs: 10_000 });
      expect((waited.data as OperationData).result!.output.trim()).toBe(join(base, 'beta'));

      const unknown = await router.call('operation_status', { operationId: 'op_unknownunknownunknownunknown' });
      expect(unknown.error?.code).toBe('NOT_FOUND');
    });

    it('serves operations on a single-root stdio backend too', async () => {
      const single = new LocalWorkspaceBackend(join(base, 'alpha'), options);
      try {
        const started = await single.call('exec_run', { workspaceId: single.workspaceId, command: 'echo single', async: true });
        const waited = await single.call('operation_wait', { operationId: (started.data as OperationData).operationId, timeoutMs: 10_000 });
        expect(waited.ok).toBe(true);
        expect((waited.data as OperationData).result!.output).toContain('single');
      } finally {
        await single.close();
      }
    });
  });

  describe('tools/list and unsupported tools', () => {
    const hidden: RunnerOperation[] = [
      'agent_spawn', 'agent_list', 'knowledge_list', 'model_profile_list', 'artifacts_list', 'packages_plan',
      'secrets_list', 'github_read', 'github_action', 'workspace_open', 'workspace_finalize', 'git_push', 'git_pull',
      'git_identity_set', 'skill_suggest'
    ];

    it('leaves remote-only tools out of the local HTTP tool list and keeps local ones', async () => {
      const names = await listTools(router);
      for (const name of hidden) expect(names, name).not.toContain(name);
      // Neither temp root is a Git repository, and HTTP keeps no active-workspace preference.
      expect(names).not.toContain('worktrees_create');
      expect(names).not.toContain('workspace_set_active');
      for (const name of ['exec_run', 'bash', 'tasks_run', 'tasks_status', 'operation_wait', 'operation_status', 'operation_cancel', 'files_write', 'git_commit', 'workspace_close']) {
        expect(names, name).toContain(name);
      }
    });

    it('offers worktrees once a registered root is a Git work tree, and workspace_set_active over stdio', async () => {
      execFileSync('git', ['init', '-q', join(base, 'beta')]);
      await pool.close();
      pool = new LocalWorkspacePool(workspaces, options);
      const names = await listTools(new MultiLocalWorkspaceBackend(pool, 'client'));
      expect(names).toContain('worktrees_create');
      expect(names).toContain('workspace_set_active');
    });

    it('keeps the full tool list for the remote backend', async () => {
      const remote: OperationBackend = { call: async () => ({ ok: true, message: 'ok', truncated: false }) };
      expect(await listTools(remote)).toHaveLength(TOOL_SPECS.length);
    });

    it('refuses hidden tools with INVALID_INPUT naming the local alternative, never a worker error', async () => {
      const cases: Array<[RunnerOperation, Record<string, unknown>, string]> = [
        ['agent_list', {}, 'tasks_run'],
        ['agent_spawn', { workspaceId: id('alpha') }, 'tasks_run'],
        ['knowledge_list', {}, 'memories_'],
        ['workspace_finalize', { workspaceId: id('alpha') }, 'git push'],
        ['git_identity_status', { workspaceId: id('alpha') }, 'git config'],
        ['skill_suggest', {}, 'skills_list'],
        ['worktrees_list', { workspaceId: id('alpha') }, 'not inside a Git work tree']
      ];
      for (const [operation, input, hint] of cases) {
        const response = await router.call(operation, input);
        expect(response.error?.code, operation).toBe('INVALID_INPUT');
        expect(response.message, operation).toContain(`${operation} is unsupported in local mode`);
        expect(response.message, operation).toContain(hint);
        expect(response.message, operation).not.toContain('unsupported worker operation');
      }
    });

    it('answers an allowed git_push with the exec_run alternative instead of a worker error', async () => {
      const pushing = new LocalWorkspaceBackend(join(base, 'alpha'), { ...options, gitNetwork: true, gitPush: true });
      try {
        const response = await pushing.call('git_push', { workspaceId: pushing.workspaceId });
        expect(response.error?.code).toBe('INVALID_INPUT');
        expect(response.message).toContain('run `git push` through exec_run');
      } finally {
        await pushing.close();
      }
    });

    it('tells clients that workspaces are pre-registered and how to run long jobs', () => {
      const instructions = router.getInstructions();
      expect(instructions).not.toMatch(/close it when finished/i);
      expect(instructions).toContain('Do not call workspace_close');
      expect(instructions).toContain('For anything longer than 300 s use tasks_run');
      expect(instructions).toContain('operation_wait');
    });

    it('keeps the "do not close" sentence out of single-root instructions, where workspace_close really closes', async () => {
      const single = new LocalWorkspaceBackend(join(base, 'alpha'), options);
      try {
        const instructions = single.getInstructions();
        expect(instructions).not.toContain('Do not call workspace_close');
        expect(instructions).toContain('For anything longer than 300 s use tasks_run');
        expect(await listTools(single)).toContain('workspace_close');
      } finally {
        await single.close();
      }
    });
  });

  describe('per-call log line', () => {
    it('logs tool, workspace, duration, and outcome without arguments or output', async () => {
      const lines: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
      const server = createCloudHarnessServer(router);
      const client = new Client({ name: 'local-log-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await client.callTool({ name: 'exec_run', arguments: { workspaceId: id('alpha'), command: 'echo secret-sentinel-value' } });
        await client.callTool({ name: 'exec_run', arguments: { workspaceId: id('alpha'), command: 'exit 4' } });
      } finally {
        await client.close();
      }
      const entries = lines.filter((line) => line.includes('"tool call"')).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ msg: 'tool call', tool: 'exec_run', workspaceId: id('alpha'), outcome: 'ok' });
      expect(typeof entries[0]!.durationMs).toBe('number');
      expect(entries[1]).toMatchObject({ tool: 'exec_run', outcome: 'error', code: 'CONFLICT' });
      expect(lines.join('')).not.toContain('secret-sentinel-value');
      expect(Object.keys(entries[0]!).sort()).toEqual(['durationMs', 'hostname', 'level', 'msg', 'outcome', 'pid', 'time', 'tool', 'workspaceId']);
      // pino's encoding, like apiLogger: numeric level, epoch-millisecond time.
      expect(entries[0]).toMatchObject({ level: 30 });
      expect(entries[1]).toMatchObject({ level: 40 });
      expect(typeof entries[0]!.time).toBe('number');
    });
  });

  describe('task records across restarts', () => {
    it('reports a task that was running at shutdown as interrupted, and finished tasks as they ended', async () => {
      const done = await router.call('tasks_run', { workspaceId: id('alpha'), command: 'echo finished', idempotencyKey: 'restart-done-1' });
      const doneId = (done.data as { taskId: string }).taskId;
      await vi.waitFor(async () => {
        const status = await router.call('tasks_status', { workspaceId: id('alpha'), taskId: doneId });
        expect((status.data as TaskView).status).toBe('succeeded');
      });
      const long = await router.call('tasks_run', { workspaceId: id('alpha'), command: 'sleep 30', idempotencyKey: 'restart-long-1', timeoutMs: 60_000 });
      const longId = (long.data as { taskId: string }).taskId;
      const asyncExec = await router.call('exec_run', { workspaceId: id('alpha'), command: 'sleep 30', async: true, timeoutMs: 60_000 });
      const operationId = (asyncExec.data as OperationData).operationId;

      // Server shutdown, then a fresh process with the same state directory.
      await pool.close();
      pool = new LocalWorkspacePool(workspaces, options, undefined, stateDir);
      router = new MultiLocalWorkspaceBackend(pool, 'explicit');

      const interrupted = await router.call('tasks_status', { workspaceId: id('alpha'), taskId: longId });
      expect(interrupted.ok).toBe(true);
      expect(interrupted.data).toMatchObject({ id: longId, status: 'interrupted' });
      expect((interrupted.data as TaskView).endedAt).toBeDefined();
      const finished = await router.call('tasks_status', { workspaceId: id('alpha'), taskId: doneId });
      expect(finished.data).toMatchObject({ status: 'succeeded', exitCode: 0 });
      expect((finished.data as TaskView).startedAt).toBeDefined();

      // The same key returns the interrupted handle instead of silently running the command again,
      // and says so rather than answering "Task queued".
      const retried = await router.call('tasks_run', { workspaceId: id('alpha'), command: 'sleep 30', idempotencyKey: 'restart-long-1' });
      expect(retried.ok).toBe(false);
      expect(retried.error).toMatchObject({ code: 'RUNNER_RESTARTED', retryable: true, message: expect.stringContaining('retry with a new idempotencyKey') });
      expect(retried.data).toMatchObject({ taskId: longId, status: 'interrupted' });
      // A finished task's key still answers ok with its handle.
      const replayed = await router.call('tasks_run', { workspaceId: id('alpha'), command: 'echo finished', idempotencyKey: 'restart-done-1' });
      expect(replayed).toMatchObject({ ok: true, data: { taskId: doneId, status: 'succeeded' } });

      const operation = await router.call('operation_status', { operationId });
      expect(operation.data).toMatchObject({ status: 'failed' });
      expect(operation.error).toMatchObject({ code: 'RUNNER_RESTARTED', retryable: true });

      // Other workspaces start empty, and tasks stay isolated per workspace after a restart.
      expect(((await router.call('tasks_list', { workspaceId: id('beta') })).data as { tasks: unknown[] }).tasks).toHaveLength(0);
      expect((await router.call('tasks_status', { workspaceId: id('beta'), taskId: longId })).error?.code).toBe('NOT_FOUND');
    });

    it('treats a record left running by a crash as interrupted and keeps the state file private and valid', async () => {
      const run = await router.call('tasks_run', { workspaceId: id('beta'), command: 'sleep 30', idempotencyKey: 'crash-1', timeoutMs: 60_000 });
      const taskId = (run.data as { taskId: string }).taskId;
      const file = join(stateDir, 'tasks', `${id('beta')}.json`);
      const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; records: Array<Record<string, unknown>> };
      expect(saved.version).toBe(1);
      expect(saved.records[0]).toMatchObject({ id: taskId, status: 'running', command: 'sleep 30', cwd: join(base, 'beta'), idempotencyKey: expect.stringContaining('crash-1') });
      expect(saved.records[0]).not.toHaveProperty('output');
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      // A crash never runs shutdown or removes its lock: a fresh process reads the record exactly
      // as it was left. Model it with a copy of the file and a lock whose pid no longer exists.
      const crashDir = join(base, 'crash-state');
      await mkdir(join(crashDir, 'tasks'), { recursive: true });
      const copied = join(crashDir, 'tasks', `${id('beta')}.json`);
      await copyFile(file, copied);
      await writeFile(`${copied}.lock`, String(deadPid()));
      const crashed = new LocalWorkspacePool(workspaces, options, undefined, crashDir);
      try {
        const status = await new MultiLocalWorkspaceBackend(crashed, 'explicit').call('tasks_status', { workspaceId: id('beta'), taskId });
        expect(status.data).toMatchObject({ status: 'interrupted' });
      } finally {
        // Its records are already interrupted, so this stops nothing.
        await crashed.close();
      }
    });

    it('lets only one live server own a state file; a second one runs without persistence', async () => {
      const first = await router.call('tasks_run', { workspaceId: id('alpha'), command: 'sleep 30', idempotencyKey: 'owner-1', timeoutMs: 60_000 });
      const firstId = (first.data as { taskId: string }).taskId;
      const file = join(stateDir, 'tasks', `${id('alpha')}.json`);
      expect((await readFile(`${file}.lock`, 'utf8')).trim()).toBe(String(process.pid));

      const warnings: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });
      const second = new LocalWorkspacePool(workspaces, options, undefined, stateDir);
      try {
        const other = new MultiLocalWorkspaceBackend(second, 'explicit');
        // It never reads (and so never marks interrupted) the first server's live task.
        expect((await other.call('tasks_status', { workspaceId: id('alpha'), taskId: firstId })).error?.code).toBe('NOT_FOUND');
        expect((await other.call('tasks_run', { workspaceId: id('alpha'), command: 'true', idempotencyKey: 'intruder-1' })).ok).toBe(true);
      } finally {
        await second.close();
      }
      expect(warnings.join('')).toContain('owns this task state');

      // The file still holds only the owner's record, still running, and the owner keeps its lock.
      const saved = JSON.parse(await readFile(file, 'utf8')) as { records: Array<{ id: string; status: string }> };
      expect(saved.records).toEqual([expect.objectContaining({ id: firstId, status: 'running' })]);
      expect((await readFile(`${file}.lock`, 'utf8')).trim()).toBe(String(process.pid));

      // Shutdown releases the lock, so the next server takes the file over.
      await pool.close();
      await expect(stat(`${file}.lock`)).rejects.toThrow();
      pool = new LocalWorkspacePool(workspaces, options, undefined, stateDir);
      router = new MultiLocalWorkspaceBackend(pool, 'explicit');
      expect((await router.call('tasks_status', { workspaceId: id('alpha'), taskId: firstId })).data).toMatchObject({ status: 'interrupted' });
    });

    it('starts empty when the state file is corrupt', async () => {
      await pool.close();
      await mkdir(join(stateDir, 'tasks'), { recursive: true });
      await writeFile(join(stateDir, 'tasks', `${id('alpha')}.json`), '{not json');
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      pool = new LocalWorkspacePool(workspaces, options, undefined, stateDir);
      router = new MultiLocalWorkspaceBackend(pool, 'explicit');
      expect(((await router.call('tasks_list', { workspaceId: id('alpha') })).data as { tasks: unknown[] }).tasks).toHaveLength(0);
      expect((await router.call('tasks_run', { workspaceId: id('alpha'), command: 'true', idempotencyKey: 'after-corrupt' })).ok).toBe(true);
    });
  });
});
