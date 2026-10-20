import pino from 'pino';
import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';

/**
 * Same level, time, and field encoding as `apiLogger`, so one jq filter reads the whole journal,
 * but on stderr: stdout carries the stdio protocol. It honours LOG_LEVEL like `apiLogger`.
 */
export const localStderrLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, process.stderr);

/**
 * One JSON line per local tool call on stderr, which journalctl captures and which never mixes
 * with the stdio protocol on stdout. It records only the tool, workspace, duration, and outcome:
 * never arguments, output, or anything else a caller sent, so commands and file bodies stay out
 * of the journal.
 */
export function logLocalToolCall(operation: RunnerOperation | string, workspaceId: string | undefined, durationMs: number, response?: RunnerResponse): void {
  const entry = {
    tool: operation,
    ...(workspaceId ? { workspaceId } : {}),
    durationMs: Math.round(durationMs),
    outcome: response?.ok ? 'ok' : 'error',
    ...(response?.ok ? {} : { code: response?.error?.code ?? 'EXCEPTION' })
  };
  try {
    if (response?.ok) localStderrLogger.info(entry, 'tool call');
    else localStderrLogger.warn(entry, 'tool call');
  } catch {
    // a closed stderr must never fail the call
  }
}
