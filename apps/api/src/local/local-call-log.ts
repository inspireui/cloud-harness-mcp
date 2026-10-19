import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';

/**
 * One JSON line per local tool call on stderr, which journalctl captures and which never mixes
 * with the stdio protocol on stdout. It records only the tool, workspace, duration, and outcome:
 * never arguments, output, or anything else a caller sent, so commands and file bodies stay out
 * of the journal.
 */
export function logLocalToolCall(operation: RunnerOperation, workspaceId: string | undefined, durationMs: number, response?: RunnerResponse): void {
  const entry = {
    level: response?.ok ? 'info' : 'warn',
    time: new Date().toISOString(),
    msg: 'tool call',
    tool: operation,
    ...(workspaceId ? { workspaceId } : {}),
    durationMs: Math.round(durationMs),
    outcome: response?.ok ? 'ok' : 'error',
    ...(response?.ok ? {} : { code: response?.error?.code ?? 'EXCEPTION' })
  };
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // a closed stderr must never fail the call
  }
}
