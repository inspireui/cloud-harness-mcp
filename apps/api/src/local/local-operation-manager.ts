import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LocalPathPolicy } from './local-path-policy.js';
import { buildLocalEnvironment } from './local-environment.js';
import type { LocalTaskStateFile, PersistedRecord } from './local-task-state.js';

/** `interrupted`: the record was running or queued when the server stopped; it never resumes. */
type ManagedStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'interrupted';

type Managed = {
  id: string;
  workspaceId: string;
  output: Buffer;
  offset: number;
  status: ManagedStatus;
  createdAt: number;
  idempotencyKey: string;
  child?: ChildProcessWithoutNullStreams;
  exitCode?: number;
  name?: string;
  dependsOn?: string[];
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  timer?: NodeJS.Timeout;
  startedAt?: number;
  endedAt?: number;
  timedOut?: boolean;
  signal?: string;
  /** Operation handles (async exec_run and bash) record which tool started them. */
  kind?: 'exec_run' | 'bash';
};

const TERMINAL: ReadonlySet<ManagedStatus> = new Set(['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted']);

const id = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

async function terminateProcess(child?: ChildProcessWithoutNullStreams, graceMs = 1000): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  child.once('close', () => resolveExit());
  child.once('exit', () => resolveExit());

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // already exited
    }
  }

  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // already dead
          }
        }
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }
  }, graceMs);

  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, graceMs + 200))
  ]);
  clearTimeout(killTimer);
}

function resolveShell(): { bin: string; args: (cmd?: string) => string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    return {
      bin: comspec,
      args: (cmd?: string) => (cmd ? ['/d', '/s', '/c', cmd] : [])
    };
  }
  const shell = process.env.SHELL || '/bin/bash';
  return {
    bin: shell,
    args: (cmd?: string) => (cmd ? ['-lc', cmd] : ['-i'])
  };
}

export class LocalOperationManager {
  private readonly tasks = new Map<string, Managed>();
  private readonly shells = new Map<string, Managed>();
  private readonly sessions = new Map<string, Managed>();
  private readonly operations = new Map<string, Managed>();
  private readonly idempotency = new Map<string, string>();
  private readonly retainedOutputBytes = 67_108_864;

  /**
   * With a `stateFile`, task and operation metadata (never output) is restored at construction and
   * rewritten on every state change, so a restart reports earlier handles instead of NOT_FOUND.
   */
  constructor(
    private readonly pathPolicy: LocalPathPolicy,
    private readonly forwardedEnvNames: string[] = [],
    private readonly stateFile?: LocalTaskStateFile
  ) {
    for (const saved of stateFile?.load() ?? []) this.restore(saved);
  }

  private restore(saved: PersistedRecord): void {
    const map = saved.id.startsWith('op_') ? this.operations : this.tasks;
    const interrupted = saved.status === 'running' || saved.status === 'queued';
    const record: Managed = {
      id: saved.id,
      workspaceId: saved.workspaceId,
      output: Buffer.alloc(0),
      offset: 0,
      status: interrupted ? 'interrupted' : saved.status,
      createdAt: saved.createdAt,
      idempotencyKey: saved.idempotencyKey,
      command: saved.command,
      cwd: saved.cwd,
      dependsOn: saved.dependsOn,
      ...(saved.kind ? { kind: saved.kind } : {}),
      ...(saved.exitCode !== undefined ? { exitCode: saved.exitCode } : {}),
      ...(saved.startedAt !== undefined ? { startedAt: saved.startedAt } : {}),
      ...(saved.endedAt !== undefined ? { endedAt: saved.endedAt } : interrupted ? { endedAt: Date.now() } : {}),
      ...(saved.timedOut ? { timedOut: true } : {})
    };
    map.set(record.id, record);
    // A repeated key still returns the earlier (now interrupted) handle, so a restart never runs a
    // command twice behind the caller's back; the caller retries with a new key.
    this.idempotency.set(record.idempotencyKey, record.id);
  }

  private persist(): void {
    if (!this.stateFile) return;
    this.stateFile.save([...this.tasks.values(), ...this.operations.values()].map((record) => ({
      id: record.id,
      workspaceId: record.workspaceId,
      idempotencyKey: record.idempotencyKey,
      command: record.command ?? '',
      cwd: record.cwd ?? '',
      status: record.status,
      createdAt: record.createdAt,
      dependsOn: record.dependsOn ?? [],
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      ...(record.timedOut ? { timedOut: true } : {})
    })));
  }

  private records(workspaceId: string): Managed[] {
    return [...this.tasks.values(), ...this.operations.values(), ...this.shells.values(), ...this.sessions.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  private enforceOutputBudget(workspaceId: string): void {
    const records = this.records(workspaceId);
    let total = records.reduce((sum, record) => sum + record.output.length, 0);
    for (const record of [
      ...records.filter((item) => item.status !== 'running'),
      ...records.filter((item) => item.status === 'running')
    ]) {
      if (total <= this.retainedOutputBytes) break;
      const removed = Math.min(record.output.length, total - this.retainedOutputBytes);
      record.output = record.output.subarray(removed);
      record.offset += removed;
      total -= removed;
    }
  }

  private reserve(map: Map<string, Managed>, workspaceId: string, limit: number): void {
    const matching = [...map.values()].filter((record) => record.workspaceId === workspaceId);
    if (matching.length < limit) return;
    const dependencies = new Set(
      [...this.tasks.values()]
        .filter((record) => record.workspaceId === workspaceId && record.status === 'queued')
        .flatMap((record) => record.dependsOn ?? [])
    );
    const evictable = matching
      .filter((record) => record.status !== 'running' && record.status !== 'queued' && !dependencies.has(record.id))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!evictable) {
      throw new Error('too many live operation handles in this workspace');
    }
    map.delete(evictable.id);
    this.idempotency.delete(evictable.idempotencyKey);
  }

  private track(record: Managed, child: ChildProcessWithoutNullStreams, maxBytes: number): void {
    record.child = child;
    const append = (chunk: Buffer) => {
      const next = Buffer.concat([record.output, chunk]);
      const removed = Math.max(0, next.length - maxBytes);
      record.offset += removed;
      record.output = next.subarray(removed);
      this.enforceOutputBudget(record.workspaceId);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    child.on('close', (code, signal) => {
      if (record.timer) {
        clearTimeout(record.timer);
      }
      record.exitCode = code ?? 1;
      if (signal) record.signal = String(signal);
      record.endedAt ??= Date.now();
      if (record.status === 'running') {
        record.status = code === 0 ? 'succeeded' : 'failed';
      }
      this.reconcileQueued(record.workspaceId);
      this.persist();
    });

    child.on('error', () => {
      if (record.timer) {
        clearTimeout(record.timer);
      }
      record.exitCode = 1;
      record.endedAt ??= Date.now();
      if (record.status === 'running') {
        record.status = 'failed';
      }
      this.reconcileQueued(record.workspaceId);
      this.persist();
    });
  }

  async execRun(
    workspaceId: string,
    command: string,
    cwdInput?: string,
    timeoutMs = 60_000,
    maxBytes = 1_048_576,
    signal?: AbortSignal
  ): Promise<{ output: string; exitCode: number; signal?: string; truncated: boolean }> {
    const cwd = await this.pathPolicy.safeCwd(cwdInput);
    const shell = resolveShell();
    const env = {
      ...buildLocalEnvironment(this.forwardedEnvNames),
      HARNESS_WORKSPACE_ROOT: this.pathPolicy.canonicalRoot
    };

    return await new Promise((resolvePromise) => {
      const child = spawn(shell.bin, shell.args(command), {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = Buffer.alloc(0);
      let truncated = false;

      const append = (chunk: Buffer) => {
        const remaining = Math.max(0, maxBytes - output.length);
        if (chunk.length > remaining) {
          truncated = true;
        }
        if (remaining > 0) {
          output = Buffer.concat([output, chunk.subarray(0, remaining)]);
        }
        if (truncated) {
          terminateProcess(child);
        }
      };

      child.stdout.on('data', append);
      child.stderr.on('data', append);

      const timer = setTimeout(() => {
        terminateProcess(child);
      }, timeoutMs);

      const onAbort = () => {
        terminateProcess(child);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('close', (exitCode, sig) => {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolvePromise({
          output: output.toString('utf8'),
          exitCode: exitCode ?? 1,
          ...(sig ? { signal: String(sig) } : {}),
          truncated
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolvePromise({
          output: err.message,
          exitCode: 1,
          truncated: false
        });
      });

      child.stdin.end();
    });
  }

  async openInteractive(
    map: Map<string, Managed>,
    prefix: 'sh' | 'sess',
    kind: 'shell' | 'session',
    workspaceId: string,
    cwdInput?: string,
    key = 'default',
    maxBytes = 1_048_576,
    name?: string,
    command?: string
  ): Promise<Managed> {
    const mapKey = `${kind}:${workspaceId}:${key}`;
    const prior = this.idempotency.get(mapKey);
    if (prior) {
      const existing = map.get(prior);
      if (existing) return existing;
    }

    this.reserve(map, workspaceId, 32);

    if (
      name &&
      [...map.values()].some(
        (record) => record.workspaceId === workspaceId && record.name === name && record.status === 'running'
      )
    ) {
      throw new Error(`session ${name} is already running`);
    }

    const cwd = await this.pathPolicy.safeCwd(cwdInput);
    const shell = resolveShell();
    const env = {
      ...buildLocalEnvironment(this.forwardedEnvNames),
      HARNESS_WORKSPACE_ROOT: this.pathPolicy.canonicalRoot
    };

    const recordId = id(prefix);
    const record: Managed = {
      id: recordId,
      workspaceId,
      output: Buffer.alloc(0),
      offset: 0,
      status: 'running',
      createdAt: Date.now(),
      idempotencyKey: mapKey,
      cwd,
      ...(name ? { name } : {})
    };

    const child = spawn(shell.bin, shell.args(command), {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    map.set(record.id, record);
    this.idempotency.set(mapKey, record.id);
    this.track(record, child, maxBytes);
    return record;
  }

  async openShell(workspaceId: string, cwd?: string, key = 'default', maxBytes = 1_048_576): Promise<Managed> {
    return await this.openInteractive(this.shells, 'sh', 'shell', workspaceId, cwd, key, maxBytes);
  }

  interactiveIo(map: Map<string, Managed>, workspaceId: string, recordId: string, input?: string): Managed {
    const record = map.get(recordId);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error('interactive session not found');
    }
    if (input && record.status === 'running') {
      record.child?.stdin.write(input);
    }
    return record;
  }

  shellIo(workspaceId: string, shellId: string, input?: string): Managed {
    return this.interactiveIo(this.shells, workspaceId, shellId, input);
  }

  closeInteractive(map: Map<string, Managed>, workspaceId: string, recordId: string): Managed {
    const record = this.interactiveIo(map, workspaceId, recordId);
    if (record.status !== 'running') {
      return record;
    }
    terminateProcess(record.child);
    record.status = 'cancelled';
    record.child?.stdin.end();
    return record;
  }

  closeShell(workspaceId: string, shellId: string): Managed {
    return this.closeInteractive(this.shells, workspaceId, shellId);
  }

  async openSession(
    workspaceId: string,
    name: string,
    command?: string,
    cwd?: string,
    key = 'default',
    maxBytes = 1_048_576
  ): Promise<Managed> {
    return await this.openInteractive(this.sessions, 'sess', 'session', workspaceId, cwd, key, maxBytes, name, command);
  }

  sessionIo(workspaceId: string, sessionId: string, input?: string): Managed {
    return this.interactiveIo(this.sessions, workspaceId, sessionId, input);
  }

  closeSession(workspaceId: string, sessionId: string): Managed {
    return this.closeInteractive(this.sessions, workspaceId, sessionId);
  }

  listSessions(workspaceId: string): Managed[] {
    return [...this.sessions.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async runTask(
    workspaceId: string,
    command: string,
    cwdInput?: string,
    key = 'default',
    timeoutMs = 60_000,
    maxBytes = 1_048_576,
    dependsOn: string[] = []
  ): Promise<Managed> {
    const mapKey = `task:${workspaceId}:${key}`;
    const prior = this.idempotency.get(mapKey);
    if (prior) {
      const existing = this.tasks.get(prior);
      if (existing) return existing;
    }

    this.reserve(this.tasks, workspaceId, 128);

    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error('task dependencies must be unique');
    }
    for (const dependencyId of dependsOn) {
      const dependency = this.tasks.get(dependencyId);
      if (!dependency || dependency.workspaceId !== workspaceId) {
        throw new Error(`task dependency ${dependencyId} not found`);
      }
    }

    const cwd = await this.pathPolicy.safeCwd(cwdInput);

    const record: Managed = {
      id: id('task'),
      workspaceId,
      output: Buffer.alloc(0),
      offset: 0,
      status: 'queued',
      createdAt: Date.now(),
      idempotencyKey: mapKey,
      command,
      cwd,
      timeoutMs,
      maxBytes,
      dependsOn: [...dependsOn]
    };

    this.tasks.set(record.id, record);
    this.idempotency.set(mapKey, record.id);
    this.reconcileQueued(workspaceId);
    this.persist();
    return record;
  }

  /**
   * Starts an async `exec_run`/`bash` command as an operation handle. It runs like a task (same
   * spawn, timeout, and bounded output), but is addressed through operation_status, operation_wait,
   * and operation_cancel with an `op_` ID, the shape the remote runner returns.
   */
  async startOperation(
    workspaceId: string,
    kind: 'exec_run' | 'bash',
    command: string,
    cwdInput?: string,
    timeoutMs = 60_000,
    maxBytes = 1_048_576
  ): Promise<Managed> {
    this.reserve(this.operations, workspaceId, 128);
    const cwd = await this.pathPolicy.safeCwd(cwdInput);
    const recordId = id('op');
    const record: Managed = {
      id: recordId,
      workspaceId,
      output: Buffer.alloc(0),
      offset: 0,
      status: 'queued',
      createdAt: Date.now(),
      idempotencyKey: `operation:${workspaceId}:${recordId}`,
      command,
      cwd,
      timeoutMs,
      maxBytes,
      kind
    };
    this.operations.set(record.id, record);
    this.startTask(record);
    this.persist();
    return record;
  }

  operation(workspaceId: string, operationId: string): Managed {
    const record = this.operations.get(operationId);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error(`operation ${operationId} not found`);
    }
    return record;
  }

  hasOperation(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  cancelOperation(workspaceId: string, operationId: string): Managed {
    const record = this.operation(workspaceId, operationId);
    if (record.status !== 'running') return record;
    terminateProcess(record.child);
    record.status = 'cancelled';
    record.endedAt = Date.now();
    this.persist();
    return record;
  }

  /** Resolves once the operation is terminal or `timeoutMs` elapses (or `signal` aborts). */
  async waitOperation(workspaceId: string, operationId: string, timeoutMs: number, signal?: AbortSignal): Promise<Managed> {
    const record = this.operation(workspaceId, operationId);
    const deadline = Date.now() + timeoutMs;
    while (!TERMINAL.has(record.status) && Date.now() < deadline && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
    }
    return record;
  }

  private startTask(record: Managed): void {
    const shell = resolveShell();
    const env = {
      ...buildLocalEnvironment(this.forwardedEnvNames),
      HARNESS_WORKSPACE_ROOT: this.pathPolicy.canonicalRoot
    };

    const child = spawn(shell.bin, shell.args(record.command), {
      cwd: record.cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.end();
    record.status = 'running';
    record.startedAt = Date.now();
    if (record.timeoutMs) {
      record.timer = setTimeout(() => {
        record.timedOut = true;
        terminateProcess(record.child);
      }, record.timeoutMs);
    }
    this.track(record, child, record.maxBytes!);
  }

  private reconcileQueued(workspaceId: string): void {
    for (const record of this.tasks.values()) {
      if (record.workspaceId !== workspaceId || record.status !== 'queued') continue;
      const dependencies = (record.dependsOn ?? []).map((depId) => this.tasks.get(depId));
      if (dependencies.some((dep) => !dep || dep.workspaceId !== workspaceId)) {
        record.status = 'blocked';
        continue;
      }
      if (dependencies.some((dep) => ['failed', 'cancelled', 'blocked', 'interrupted'].includes(dep!.status))) {
        record.status = 'blocked';
        continue;
      }
      if (dependencies.every((dep) => dep!.status === 'succeeded')) {
        this.startTask(record);
      }
    }
  }

  task(workspaceId: string, taskId: string): Managed {
    const record = this.tasks.get(taskId);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error('task not found');
    }
    return record;
  }

  listTasks(workspaceId: string): Managed[] {
    return [...this.tasks.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  taskGraph(workspaceId: string): {
    nodes: Array<{ id: string; status: ManagedStatus; exitCode?: number; name?: string; dependsOn?: string[] }>;
    edges: Array<{ from: string; to: string }>;
  } {
    const tasks = this.listTasks(workspaceId);
    return {
      nodes: tasks.map((record) => this.summary(record)),
      edges: tasks.flatMap((record) => (record.dependsOn ?? []).map((depId) => ({ from: depId, to: record.id })))
    };
  }

  cancelTask(workspaceId: string, taskId: string): Managed {
    const record = this.task(workspaceId, taskId);
    if (record.status === 'queued') {
      record.status = 'cancelled';
      record.endedAt = Date.now();
      this.reconcileQueued(workspaceId);
      this.persist();
      return record;
    }
    if (record.status !== 'running') {
      return record;
    }
    terminateProcess(record.child);
    record.status = 'cancelled';
    record.endedAt = Date.now();
    this.reconcileQueued(workspaceId);
    this.persist();
    return record;
  }

  /**
   * Server shutdown: stops every process like `stopWorkspace`, but keeps task and operation
   * records and saves them as `interrupted`, so the next start still reports them.
   */
  async shutdown(): Promise<void> {
    const toTerminate: ChildProcessWithoutNullStreams[] = [];
    const now = Date.now();
    for (const record of [...this.tasks.values(), ...this.operations.values(), ...this.shells.values(), ...this.sessions.values()]) {
      if (record.status === 'running' || record.status === 'queued') {
        record.status = record.id.startsWith('task_') || record.id.startsWith('op_') ? 'interrupted' : 'cancelled';
        record.endedAt = now;
        if (record.child) toTerminate.push(record.child);
      }
    }
    this.persist();
    await Promise.all(toTerminate.map((c) => terminateProcess(c)));
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const toTerminate: ChildProcessWithoutNullStreams[] = [];
    for (const record of this.records(workspaceId)) {
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'cancelled';
        if (record.child) toTerminate.push(record.child);
      }
    }
    await Promise.all(toTerminate.map((c) => terminateProcess(c)));
    for (const [recordId, record] of this.tasks) {
      if (record.workspaceId === workspaceId) this.tasks.delete(recordId);
    }
    for (const [recordId, record] of this.operations) {
      if (record.workspaceId === workspaceId) this.operations.delete(recordId);
    }
    for (const [recordId, record] of this.shells) {
      if (record.workspaceId === workspaceId) this.shells.delete(recordId);
    }
    for (const [recordId, record] of this.sessions) {
      if (record.workspaceId === workspaceId) this.sessions.delete(recordId);
    }
    for (const key of this.idempotency.keys()) {
      if (key.includes(`:${workspaceId}:`)) this.idempotency.delete(key);
    }
    this.persist();
  }

  view(record: Managed): {
    id: string;
    status: ManagedStatus;
    exitCode?: number;
    output: string;
    name?: string;
    dependsOn?: string[];
    startedAt?: string;
    endedAt?: string;
  } {
    return {
      id: record.id,
      status: record.status,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      output: record.output.toString('utf8'),
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.dependsOn !== undefined ? { dependsOn: record.dependsOn } : {}),
      ...(record.startedAt !== undefined ? { startedAt: new Date(record.startedAt).toISOString() } : {}),
      ...(record.endedAt !== undefined ? { endedAt: new Date(record.endedAt).toISOString() } : {})
    };
  }

  summary(record: Managed): {
    id: string;
    status: ManagedStatus;
    exitCode?: number;
    name?: string;
    dependsOn?: string[];
  } {
    return {
      id: record.id,
      status: record.status,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.dependsOn !== undefined ? { dependsOn: record.dependsOn } : {})
    };
  }

  viewSince(record: Managed, cursor?: string): {
    data: ReturnType<LocalOperationManager['view']>;
    cursor: string;
    truncated: boolean;
  } {
    const requested = cursor === undefined ? 0 : Number(cursor);
    const end = record.offset + record.output.length;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > end) {
      throw new Error('invalid output cursor');
    }
    const missedOutput = requested < record.offset;
    const start = Math.max(0, requested - record.offset);
    const page = record.output.subarray(start, Math.min(record.output.length, start + 65_536));
    const nextCursor = record.offset + start + page.length;
    return {
      data: { ...this.view(record), output: page.toString('utf8') },
      cursor: String(nextCursor),
      truncated: missedOutput || nextCursor < end
    };
  }
}
