import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

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

/**
 * One small JSON file per registered workspace, replaced atomically (write a temporary file, then
 * rename it over the old one), so a crash mid-write leaves the previous complete file. Commands can
 * contain sensitive arguments, so the directory and file are private to the host user.
 */
export class LocalTaskStateFile {
  private warned = false;

  constructor(private readonly path: string) {}

  static forWorkspace(stateDir: string, workspaceId: string): LocalTaskStateFile {
    return new LocalTaskStateFile(join(stateDir, 'tasks', `${workspaceId}.json`));
  }

  /** A missing, unreadable, or invalid file starts empty instead of stopping the server. */
  load(): PersistedRecord[] {
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

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`${JSON.stringify({ level: 'warn', msg: message, path: this.path })}\n`);
  }
}
