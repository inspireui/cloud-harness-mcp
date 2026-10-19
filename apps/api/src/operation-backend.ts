import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';
import type { EventsBackend } from './events/events-extension.js';

/** Read-only runner operations behind the Skills over MCP extension. */
export type SkillsExtensionOperation = 'skills_ext_list' | 'skills_ext_get' | 'skills_ext_read';

export interface OperationBackend {
  call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  /**
   * Serves the Skills over MCP extension for the backend's bound principal.
   * Backends without it (the local stdio backend) do not advertise the extension.
   */
  callSkillsExtension?(
    operation: SkillsExtensionOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  /** MCP Events for the backend's bound principal; backends without it do not advertise `events`. */
  readonly events?: EventsBackend | undefined;
  getInstructions?(): string;
  /**
   * Local backends leave tools they cannot serve out of tools/list. Absent (the remote backend)
   * means every tool is listed.
   */
  supportsOperation?(operation: RunnerOperation): boolean;
  /** A replacement tool description for this backend's semantics; undefined keeps the shared one. */
  describeOperation?(operation: RunnerOperation): string | undefined;
  /** Called once per tool call with its duration and result (undefined when the call threw). */
  logToolCall?(operation: RunnerOperation, input: Record<string, unknown>, durationMs: number, response?: RunnerResponse): void;
  close?(): Promise<void>;
}
