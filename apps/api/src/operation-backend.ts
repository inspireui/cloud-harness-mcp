import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';
import type { z } from 'zod';
import type { EventsBackend } from './events/events-extension.js';

/** Read-only runner operations behind the Skills over MCP extension. */
export type SkillsExtensionOperation = 'skills_ext_list' | 'skills_ext_get' | 'skills_ext_read';

/**
 * A tool a backend serves outside the shared runner catalog (`TOOL_SPECS`), such as the local-only
 * `files_import`. Remote backends have none, so their tools/list is unchanged.
 */
export type BackendTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** Tool descriptor `_meta`, for example the Apps SDK `openai/fileParams` list. */
  _meta?: Record<string, unknown>;
};

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
  /** Extra tools this backend serves; each call goes to `callBackendTool`. */
  backendTools?(): BackendTool[];
  callBackendTool?(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse>;
  /** Called once per tool call with its duration and result (undefined when the call threw). */
  logToolCall?(operation: RunnerOperation | string, input: Record<string, unknown>, durationMs: number, response?: RunnerResponse): void;
  close?(): Promise<void>;
}
