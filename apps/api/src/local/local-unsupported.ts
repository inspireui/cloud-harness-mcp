import { spawnSync } from 'node:child_process';
import { isModelToolOperation, type RunnerOperation, type RunnerResponse } from '@cloud-harness/contracts';

/**
 * Tools that no local backend can serve: they need the remote runner's agents, stores, or GitHub
 * broker, or the local worker has no handler for them. Local servers leave them out of tools/list,
 * and a call that names one anyway gets this explanation with the local alternative instead of a
 * generic worker error. Remote mode never consults this table.
 */
const UNSUPPORTED_PREFIXES: Array<[prefix: string, reason: string]> = [
  ['agent_', 'managed agents run only in the remote runner; start a CLI agent (for example `claude -p` or `codex exec`) with tasks_run and poll tasks_status'],
  ['knowledge_', 'the knowledge graph lives in the remote runner store; keep notes as workspace files or use memories_*'],
  ['artifacts_', 'retained artifacts require remote runner storage; keep outputs as workspace files or commit them with git'],
  ['packages_', 'managed toolbox packages need the remote runner\'s isolated builder and release store; install project tools in the workspace instead']
];

const UNSUPPORTED_OPERATIONS = new Map<RunnerOperation, string>([
  ['workspace_finalize', 'local workspaces have no remote finalization; commit with git_commit and push with exec_run running `git push`'],
  ['secrets_list', 'retained environment secrets require remote runner storage; the server forwards only the host variables the operator allowed with --env'],
  ['github_read', 'the local server has no GitHub broker; run the `gh` CLI through exec_run (for example `gh pr view 12 --json reviews`), which uses the host user\'s gh login'],
  ['github_action', 'the local server has no GitHub broker; run the `gh` CLI through exec_run (for example `gh pr create` or `gh pr comment`), which uses the host user\'s gh login'],
  ['git_identity_status', 'the local worker does not manage Git identity; run `git config user.name` and `git config user.email` through exec_run'],
  ['git_identity_set', 'the local worker does not manage Git identity; run `git config user.name ...` and `git config user.email ...` through exec_run'],
  ['skill_suggest', 'skill suggestions need the remote runner; call skills_list and read a match with skills_read']
]);

/** Network Git tools the worker cannot run; the policy gate still answers first when they are disabled. */
const WORKER_UNIMPLEMENTED_GIT = new Map<RunnerOperation, string>([
  ['git_pull', 'the local worker does not implement git_pull; run `git pull` through exec_run'],
  ['git_push', 'the local worker does not implement git_push; run `git push` through exec_run']
]);

export type LocalToolContext = {
  /** Multi-workspace HTTP routers keep no session, so `workspace_set_active` cannot apply there. */
  selection: 'single' | 'client' | 'explicit';
  /** False when no registered root is inside a Git work tree, so `worktrees_*` cannot succeed anywhere. */
  anyGitRoot: boolean;
};

export function unsupportedLocalReason(operation: RunnerOperation): string | undefined {
  if (isModelToolOperation(operation)) {
    return 'model profiles live in the remote runner; use the remote MCP endpoint or the Dashboard';
  }
  const direct = UNSUPPORTED_OPERATIONS.get(operation);
  if (direct) return direct;
  return UNSUPPORTED_PREFIXES.find(([prefix]) => operation.startsWith(prefix))?.[1];
}

export function unimplementedLocalGitReason(operation: RunnerOperation): string | undefined {
  return WORKER_UNIMPLEMENTED_GIT.get(operation);
}

/** Whether a local server should list the tool in tools/list. */
export function isLocalToolAdvertised(operation: RunnerOperation, context: LocalToolContext): boolean {
  if (operation === 'workspace_open') return false;
  if (operation === 'workspace_set_active' && context.selection !== 'client') return false;
  if (operation.startsWith('worktrees_') && !context.anyGitRoot) return false;
  return unsupportedLocalReason(operation) === undefined && unimplementedLocalGitReason(operation) === undefined;
}

export function unsupportedLocalResponse(operation: RunnerOperation, reason: string): RunnerResponse {
  const message = `${operation} is unsupported in local mode because ${reason}`;
  return { ok: false, message, error: { code: 'INVALID_INPUT', message, retryable: false }, truncated: false };
}

/** True when `root` is inside a Git work tree. Bounded so a stuck mount never blocks startup. */
export function isGitWorkTree(root: string): boolean {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 && result.stdout.trim() === 'true';
}
