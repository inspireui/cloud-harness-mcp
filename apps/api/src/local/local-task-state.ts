import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { localStderrLogger } from './local-call-log.js';

/**
 * Task and async-operation metadata saved across restarts. Output is never saved: it can hold
 * anything a command printed, and the in-memory ring buffer is the only place it lives.
 */
const PersistedRecordSchema = z.object({
  id: z.string().regex(/^(task|op)_[A-Za-z0-9_-]{20,80}$/),
  workspaceId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  command: z.string(),
  cwd: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted']),
  createdAt: z.number(),
  dependsOn: z.array(z.string()),
  kind: z.enum(['exec_run', 'bash']).optional(),
  exitCode: z.number().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  timedOut: z.boolean().optional()
});

const StateFileSchema = z.object({ version: z.literal(1), records: z.array(PersistedRecordSchema) });

export type PersistedRecord = z.infer<typeof PersistedRecordSchema>;

/** Default state directory when the workspace config sets no `stateDir`. */
export function defaultLocalStateDir(): string {
  return join(homedir(), '.local', 'state', 'cloud-harness-local');
}

/** Lock files this process holds, so a second pool in the same process is refused like another process. */
const heldLocks = new Set<string>();

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One small JSON file per registered workspace, replaced atomically (write a temporary file, then
 * rename it over the old one), so a crash mid-write leaves the previous complete file. Commands can
 * contain sensitive arguments, so the directory and file are private to the host user.
 *
 * Each file belongs to one server process: `load` takes `<file>.lock` (created exclusively, holding
 * the pid) and every save rewrites the whole file from that process's memory. A second process on
 * the same `stateDir` and workspace would otherwise mark the first one's live tasks interrupted and
 * overwrite its records, so it runs without persistence and warns once instead. A lock left by a
 * crashed process (its pid is gone) is taken over.
 */
export class LocalTaskStateFile {
  private warned = false;
  private owned = false;
  private readonly lockPath: string;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  static forWorkspace(stateDir: string, workspaceId: string): LocalTaskStateFile {
    return new LocalTaskStateFile(join(stateDir, 'tasks', `${workspaceId}.json`));
  }

  /** True while this instance holds the lock and saves its records. */
  get persistent(): boolean {
    return this.owned;
  }

  /**
   * Takes the lock, then reads the file. A missing, unreadable, or invalid file starts empty
   * instead of stopping the server; a file another live process owns is never read.
   */
  load(): PersistedRecord[] {
    if (!this.acquire()) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = StateFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data.records;
    } catch {
      // fall through to the warning
    }
    this.warn('ignored an invalid task state file');
    return [];
  }

  save(records: PersistedRecord[]): void {
    if (!this.owned) return;
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ version: 1, records }), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      // Persistence is best effort: a full disk must never fail the tool call that changed state.
      this.warn(`could not save task state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Server shutdown: later saves are dropped and the next process can take the file. */
  release(): void {
    if (!this.owned) return;
    this.owned = false;
    heldLocks.delete(this.lockPath);
    try {
      if (readFileSync(this.lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }

  private acquire(): boolean {
    if (this.owned) return true;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    } catch (error) {
      this.warn(`could not create the task state directory: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        heldLocks.add(this.lockPath);
        this.owned = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.warn(`could not lock task state, running without persistence: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      }
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(this.lockPath, 'utf8').trim());
      } catch {
        // removed in between: retry
      }
      const live = Number.isSafeInteger(holder) && holder > 0 && (holder === process.pid ? heldLocks.has(this.lockPath) : processAlive(holder));
      if (live) {
        this.warn(`another server process (pid ${holder}) owns this task state; running without persistence. Give each server process its own stateDir`);
        return false;
      }
      try {
        unlinkSync(this.lockPath);
      } catch {
        // another process took it over first; the retry decides
      }
    }
    this.warn('could not lock task state, running without persistence');
    return false;
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    localStderrLogger.warn({ path: this.path }, message);
  }
}
