import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { applyGuidanceActivity, sanitizeAndAttributeProvenance, type GuidanceProfile, type RunnerOperation, type RunnerResponse } from '@cloud-harness/contracts';
import type { OperationBackend } from '../operation-backend.js';
import type { CliOptions } from '../cli-options.js';
import { LocalPathPolicy } from './local-path-policy.js';
import { LocalWorkerClient } from './local-worker-client.js';
import { LocalOperationManager } from './local-operation-manager.js';
import type { LocalTaskStateFile } from './local-task-state.js';
import { logLocalToolCall } from './local-call-log.js';
import {
  isGitWorkTree,
  isLocalToolAdvertised,
  unimplementedLocalGitReason,
  unsupportedLocalReason,
  unsupportedLocalResponse
} from './local-unsupported.js';

const opaqueId = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

/** operation_wait never blocks longer than its schema maximum. */
const OPERATION_WAIT_MAX_MS = 300_000;

/** Shared by the single-root and multi-root local servers. */
export const LOCAL_LONG_JOB_GUIDANCE = 'exec_run and bash block for at most their timeoutMs (default 60000, max 300000). '
  + 'For anything longer than 300 s use tasks_run (unique idempotencyKey, explicit timeoutMs) and poll tasks_status with its cursor; '
  + 'async: true on exec_run/bash only frees the call while a command of up to 300 s runs, then operation_wait collects it. '
  + 'Remote-only tools (agents, knowledge, artifacts, packages, model profiles, GitHub broker) are not offered here and calls to them answer "tool not found"; '
  + 'use the gh CLI through exec_run for GitHub and tasks_run with a CLI agent for sub-agents.';

/** Only for the pre-registered roots of a workspace config, which clients cannot close. */
export const LOCAL_REGISTERED_GUIDANCE = 'Do not call workspace_close when finished: local workspaces are pre-registered and stay open. ';

export class LocalWorkspaceBackend implements OperationBackend {
  public readonly workspaceId: string;
  private status: 'ACTIVE' | 'CLOSED' = 'ACTIVE';
  private readonly createdAt: number;
  private lastActivityAt: number;
  private readonly pathPolicy: LocalPathPolicy;
  private readonly workerClient: LocalWorkerClient;
  private readonly operationManager: LocalOperationManager;
  private gitRootCache: boolean | undefined;
  /** Set by the multi-workspace pool: a shared registered root never offers workspace_close. */
  registered = false;

  constructor(
    public readonly canonicalRoot: string,
    public readonly options: CliOptions,
    workerScriptPath?: string,
    workspaceId?: string,
    stateFile?: LocalTaskStateFile
  ) {
    this.workspaceId = workspaceId ?? opaqueId('ws_local');
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.pathPolicy = new LocalPathPolicy(canonicalRoot);
    this.workerClient = new LocalWorkerClient(canonicalRoot, workerScriptPath);
    this.operationManager = new LocalOperationManager(this.pathPolicy, options.env, stateFile);
  }

  getInstructions(): string {
    return `This is a Cloud Harness local stdio workspace. Operations execute against the selected project folder (${this.canonicalRoot}) with host-user permissions. The workspace is already open (workspaceId: "${this.workspaceId}"). Path confinement prevents tool path escapes; commands run with host authority. ${LOCAL_LONG_JOB_GUIDANCE}`;
  }

  /** Whether the root was inside a Git work tree when first asked; tools/list uses the cached answer. */
  get gitRoot(): boolean {
    this.gitRootCache ??= isGitWorkTree(this.canonicalRoot);
    return this.gitRootCache;
  }

  supportsOperation(operation: RunnerOperation): boolean {
    return isLocalToolAdvertised(operation, { selection: 'single', anyGitRoot: this.gitRoot });
  }

  logToolCall(operation: RunnerOperation, input: Record<string, unknown>, durationMs: number, response?: RunnerResponse): void {
    logLocalToolCall(operation, typeof input.workspaceId === 'string' ? input.workspaceId : this.workspaceId, durationMs, response);
  }

  hasOperation(operationId: string): boolean {
    return this.operationManager.hasOperation(operationId);
  }

  get closed(): boolean {
    return this.status === 'CLOSED';
  }

  getPublicRecord() {
    return {
      workspaceId: this.workspaceId,
      repositoryUrl: `local://${this.canonicalRoot}`,
      ref: 'HEAD',
      status: this.status,
      networkProfile: 'local-host',
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000 * 365).toISOString(),
      leaseState: this.status === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED',
      canRenewLease: false,
      availableActions: this.status === 'ACTIVE'
        ? ['workspace_lease_renew', 'workspace_recover', ...(this.registered ? [] : ['workspace_close']), 'workspace_context']
        : []
    };
  }

  private getCapabilities() {
    const gitNetwork = Boolean(this.options.gitNetwork);
    const gitPush = Boolean(this.options.gitPush);
    return {
      workspaceId: this.workspaceId,
      repository: `local://${this.canonicalRoot}`,
      repositoryUrl: `local://${this.canonicalRoot}`,
      capabilities: {
        repository: {
          read: true,
          push: gitPush,
          issuesRead: false,
          issuesWrite: false,
          pullRequestsRead: false,
          pullRequestsWrite: false
        },
        workspace: {
          mode: 'local',
          platform: process.platform,
          gitNetwork,
          gitPush,
          sandboxed: false,
          shell: true,
          tasks: true,
          sessions: true,
          deployments: true,
          privileged: false,
          networkProfile: 'local-host',
          defaultNetworkProfile: 'local-host'
        },
        mode: 'local',
        platform: process.platform,
        gitNetwork,
        gitPush,
        sandboxed: false
      },
      permissions: {
        contents: { read: true, write: true },
        issues: { read: false, write: false },
        pullRequests: { read: false, write: false }
      },
      operations: {
        gitFetch: gitNetwork,
        gitPull: gitNetwork,
        gitPush,
        issueList: false,
        issueView: false,
        issueCreate: false,
        issueComment: false,
        issueUpdate: false,
        issuePublish: false,
        labelCreate: false,
        pullRequestList: false,
        pullRequestView: false,
        pullRequestCreate: false,
        commitList: false,
        compare: false,
        releaseList: false,
        tagList: false,
        execRun: true,
        privilegedExec: false,
        deploymentsRun: true
      }
    };
  }
  async close(): Promise<void> {
    this.status = 'CLOSED';
    await this.operationManager.stopWorkspace(this.workspaceId);
  }

  /** Server shutdown: stops processes but keeps task records, saved as interrupted. */
  async shutdown(): Promise<void> {
    this.status = 'CLOSED';
    await this.operationManager.shutdown();
  }

  async call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    this.lastActivityAt = Date.now();

    if (operation === 'workspace_list') {
      if (this.status === 'CLOSED') {
        return { ok: true, message: 'Listed 0 workspaces', data: { workspaces: [] }, truncated: false };
      }
      return {
        ok: true,
        message: 'Listed 1 workspace',
        data: { workspaces: [this.getPublicRecord()] },
        truncated: false
      };
    }

    if (operation === 'bash' && input.target === 'toolbox') {
      const message = 'the bash toolbox target is unsupported in local mode because it needs the remote runner\'s disposable containers; use target "workspace"';
      return { ok: false, message, error: { code: 'INVALID_INPUT', message, retryable: false }, truncated: false };
    }

    // GitHub tools keep their structured capability error below; every other remote-only tool is
    // refused here with its local alternative instead of reaching the worker.
    const unsupported = operation === 'github_read' || operation === 'github_action' ? undefined : unsupportedLocalReason(operation);
    if (unsupported) return unsupportedLocalResponse(operation, unsupported);
    if (operation === 'workspace_set_active') {
      return unsupportedLocalResponse(operation, `this server has exactly one workspace; pass workspaceId "${this.workspaceId}"`);
    }

    if (operation === 'workspace_open') {
      return {
        ok: false,
        message: 'workspace_open is unsupported in local stdio mode because the workspace is selected at startup via --workspace',
        error: {
          code: 'INVALID_INPUT',
          message: 'workspace_open is unsupported in local stdio mode because the workspace is selected at startup via --workspace',
          retryable: false
        },
        truncated: false
      };
    }

    if (operation === 'workspace_capabilities') {
      if (input.workspaceId && input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      return {
        ok: true,
        message: 'Workspace capabilities retrieved',
        data: this.getCapabilities(),
        truncated: false
      };
    }

    if (operation === 'workspace_status') {
      if ((input.workspaceId && input.workspaceId !== this.workspaceId) || this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      const caps = this.getCapabilities();
      return {
        ok: true,
        message: 'Workspace status retrieved',
        data: {
          ...this.getPublicRecord(),
          root: this.canonicalRoot,
          capabilities: caps.capabilities,
          permissions: caps.permissions,
          operations: caps.operations
        },
        truncated: false
      };
    }

    if (operation === 'workspace_context') {
      if (input.workspaceId && input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      if (this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace is closed',
          error: { code: 'NOT_FOUND', message: 'workspace is closed', retryable: false },
          truncated: false
        };
      }
      const caps = this.getCapabilities();
      let manifest: unknown = undefined;
      try {
        const scanRes = await this.workerClient.call('workspace_context', input, signal);
        if (scanRes.ok && scanRes.data && typeof scanRes.data === 'object' && 'manifest' in scanRes.data) {
          const rawManifest = scanRes.data.manifest as Record<string, unknown>;
          const rawItems = Array.isArray(rawManifest.items) ? rawManifest.items : [];
          const maxBytes = Math.min(Math.max(Number((input as { maxBytes?: number }).maxBytes || 32768), 4096), 131072);
          const sanitizedItems: any[] = [];
          let accumulatedBytes = 0;
          let truncated = Boolean(rawManifest.truncated);
          const truncationReasons = Array.isArray(rawManifest.truncationReasons) ? [...rawManifest.truncationReasons] : [];

          // Instruction activity is decided by the same selection agent bootstrap uses, so the
          // manifest and an agent's injected guidance cannot disagree about which files apply.
          const attributedItems = applyGuidanceActivity((rawItems as Record<string, unknown>[]).map((rawItem) => sanitizeAndAttributeProvenance(rawItem, {
            partitionSource: 'repository',
            repositoryRoot: this.canonicalRoot
          })), (input as { clientProfile?: GuidanceProfile }).clientProfile ?? 'all');
          for (const item of attributedItems) {
            const itemBytes = Buffer.byteLength(JSON.stringify(item));
            if (accumulatedBytes + itemBytes > maxBytes) {
              truncated = true;
              if (!truncationReasons.includes('byte-budget')) truncationReasons.push('byte-budget');
              break;
            }
            sanitizedItems.push(item);
            accumulatedBytes += itemBytes;
          }

          const precedenceRank: Record<string, number> = {
            'built-in': 4,
            'owner': 3,
            'workspace': 2,
            'repository': 1
          };

          const mergeSkillItem = (sItem: any) => {
            const existingIdx = sanitizedItems.findIndex(it => it.id === sItem.id);
            if (existingIdx === -1) {
              const sBytes = Buffer.byteLength(JSON.stringify(sItem));
              if (accumulatedBytes + sBytes <= maxBytes) {
                sanitizedItems.push(sItem);
                accumulatedBytes += sBytes;
              } else {
                truncated = true;
                if (!truncationReasons.includes('byte-budget')) truncationReasons.push('byte-budget');
              }
              return;
            }
            const existing = sanitizedItems[existingIdx]!;
            const newRank = precedenceRank[sItem.provenance.source] || 0;
            const existingRank = precedenceRank[existing.provenance.source] || 0;
            if (newRank <= existingRank) return;
            // Replacement is byte-accounted: return the superseded item's serialized size to the
            // budget before admitting the higher-precedence candidate, so returnedBytes is never
            // stale and a replacement can never push the manifest past maxBytes.
            const sBytes = Buffer.byteLength(JSON.stringify(sItem));
            const existingBytes = Buffer.byteLength(JSON.stringify(existing));
            const nextBytes = accumulatedBytes - existingBytes + sBytes;
            if (nextBytes > maxBytes) {
              truncated = true;
              if (!truncationReasons.includes('byte-budget')) truncationReasons.push('byte-budget');
              return;
            }
            sanitizedItems[existingIdx] = sItem;
            accumulatedBytes = nextBytes;
          };

          // Scan trusted external owner and built-in skill partitions from local host
          const include = Array.isArray((input as any).include) ? (input as any).include : ['instructions', 'languages', 'test_commands', 'skills'];
          if (include.includes('skills')) {
            const ownerRoot = process.env.CH_OWNER_SKILLS_ROOT || '/opt/cloud-harness/owner-skills';
            try {
              const ownerEntries = await readdir(ownerRoot, { withFileTypes: true });
              for (const oe of ownerEntries) {
                if (oe.isDirectory()) {
                  const sFile = join(ownerRoot, oe.name, 'SKILL.md');
                  try {
                    const sRaw = await readFile(sFile);
                    const sHash = createHash('sha256').update(sRaw).digest('hex');
                    const sItem = sanitizeAndAttributeProvenance({
                      id: `ctx_skill_${oe.name}`,
                      kind: 'skill-summary',
                      format: 'skill-md',
                      path: sFile,
                      clients: ['all'],
                      contentSha256: sHash,
                      excerpt: `Skill "${oe.name}" (owner)`
                    }, {
                      partitionSource: 'owner',
                      trustedRoot: ownerRoot
                    });
                    mergeSkillItem(sItem);
                  } catch { /* skip */ }
                }
              }
            } catch { /* owner root absent */ }

            // Local stdio mode has no executor mount, so the operator-declared
            // `BUILTIN_SKILLS_ROOT` host directory is scanned directly; the fixed mount target
            // remains the fallback.
            const builtinRoot = process.env.BUILTIN_SKILLS_ROOT || '/opt/cloud-harness/skills';
            try {
              const builtinEntries = await readdir(builtinRoot, { withFileTypes: true });
              for (const be of builtinEntries) {
                if (be.isDirectory()) {
                  const sFile = join(builtinRoot, be.name, 'SKILL.md');
                  try {
                    const sRaw = await readFile(sFile);
                    const sHash = createHash('sha256').update(sRaw).digest('hex');
                    const sItem = sanitizeAndAttributeProvenance({
                      id: `ctx_skill_${be.name}`,
                      kind: 'skill-summary',
                      format: 'skill-md',
                      path: sFile,
                      clients: ['all'],
                      contentSha256: sHash,
                      excerpt: `Skill "${be.name}" (built-in)`
                    }, {
                      partitionSource: 'built-in',
                      trustedRoot: builtinRoot
                    });
                    mergeSkillItem(sItem);
                  } catch { /* skip */ }
                }
              }
            } catch { /* builtin root absent */ }
          }
          manifest = {
            contractVersion: 1,
            returnedBytes: accumulatedBytes,
            scannedFiles: typeof rawManifest.scannedFiles === 'number' ? rawManifest.scannedFiles : sanitizedItems.length,
            scannedSourceBytes: typeof rawManifest.scannedSourceBytes === 'number' ? rawManifest.scannedSourceBytes : accumulatedBytes,
            truncated,
            truncationReasons,
            cursor: typeof rawManifest.cursor === 'string' ? rawManifest.cursor : undefined,
            items: sanitizedItems,
            warnings: Array.isArray(rawManifest.warnings) ? rawManifest.warnings : []
          };
        }
      } catch {
        // local scan is non-blocking
      }
      return {
        ok: true,
        message: 'Workspace context',
        data: {
          workspace: {
            ...this.getPublicRecord(),
            root: this.canonicalRoot,
            capabilities: caps.capabilities,
            permissions: caps.permissions,
            operations: caps.operations
          },
          branch: 'HEAD',
          gitIdentity: {
            name: 'Cloud Harness Agent',
            email: 'agent@cloud-harness.local'
          },
          capabilities: caps.capabilities,
          permissions: caps.permissions,
          operations: caps.operations,
          ...(manifest ? { manifest } : {})
        },
        truncated: false
      };
    }

    if (operation === 'workspace_close') {
      if (input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      await this.close();
      return {
        ok: true,
        message: 'Workspace closed',
        data: { workspaceId: this.workspaceId, status: 'CLOSED' },
        truncated: false
      };
    }

    if (operation === 'workspace_lease_renew') {
      if (input.workspaceId && input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      if (this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace is closed and cannot be renewed',
          error: { code: 'EXPIRED', message: 'workspace is closed and cannot be renewed', retryable: false },
          truncated: false
        };
      }
      return {
        ok: true,
        message: 'Local workspace lease is permanent',
        data: { ...this.getPublicRecord(), leaseCapped: false },
        truncated: false
      };
    }

    if (operation === 'workspace_recover') {
      if (input.workspaceId && input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      if (this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace is closed and cannot be recovered',
          error: { code: 'EXPIRED', message: 'workspace is closed and cannot be recovered', retryable: false },
          truncated: false
        };
      }
      const mode = (input.mode as string | undefined) ?? 'resume';
      if (mode === 'resume') {
        return {
          ok: true,
          message: 'Local workspace is already active',
          data: this.getPublicRecord(),
          truncated: false
        };
      }
      const workerRes = await this.workerClient.call('workspace_recover', input, signal);
      return {
        ...workerRes,
        data: {
          workspace: this.getPublicRecord(),
          ...(workerRes.data && typeof workerRes.data === 'object' ? workerRes.data : {})
        }
      };
    }

    if (this.status === 'CLOSED') {
      return {
        ok: false,
        message: 'workspace is closed',
        error: { code: 'NOT_FOUND', message: 'workspace is closed', retryable: false },
        truncated: false
      };
    }

    if (operation === 'operation_status' || operation === 'operation_wait' || operation === 'operation_cancel') {
      return await this.callOperation(operation, input, signal);
    }

    if (input.workspaceId !== this.workspaceId) {
      return {
        ok: false,
        message: 'workspace not found',
        error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
        truncated: false
      };
    }

    if (operation === 'github_action' || operation === 'github_read') {
      const action = typeof input.action === 'string' ? input.action : '';
      const scope = action.startsWith('pr_') ? 'pullRequests'
        : action.startsWith('issue_') || action === 'label_create' ? 'issues'
          : action.startsWith('commit_status_') ? 'statuses'
            : action.startsWith('check_runs_') ? 'checks'
              : action.startsWith('workflow_') ? 'actions'
                : undefined;
      const requiredCapability = operation === 'github_read'
        ? (scope ? `repository.${scope}Read` : 'repository.read')
        : `repository.${scope ?? 'issues'}Write`;
      const message = `${operation} is unsupported in local mode because ${unsupportedLocalReason(operation)}`;
      return {
        ok: false,
        message,
        error: {
          code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED',
          message,
          retryable: false,
          operation,
          repository: `local://${this.canonicalRoot}`,
          requiredCapability
        },
        truncated: false
      };
    }

    if (operation === 'exec_run' || operation === 'bash') {
      // `bash` with the workspace target is exec_run; its result also names the target.
      const target = operation === 'bash' ? { target: 'workspace' } : {};
      if (input.privileged === true) {
        return {
          ok: false,
          message: 'privileged execution is unsupported in local mode',
          error: {
            code: 'INVALID_INPUT',
            message: 'privileged execution is unsupported in local mode',
            retryable: false
          },
          truncated: false
        };
      }
      if (input.async === true) {
        try {
          const record = await this.operationManager.startOperation(
            this.workspaceId,
            operation,
            String(input.command || ''),
            typeof input.cwd === 'string' ? input.cwd : undefined,
            typeof input.timeoutMs === 'number' ? input.timeoutMs : 60_000,
            typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576
          );
          return {
            ok: true,
            message: 'Command started in background',
            data: { operationId: record.id, status: 'running' },
            truncated: false
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : `${operation} failed`;
          return { ok: false, message: msg, error: { code: 'INVALID_INPUT', message: msg, retryable: false }, truncated: false };
        }
      }
      try {
        const result = await this.operationManager.execRun(
          this.workspaceId,
          String(input.command || ''),
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.timeoutMs === 'number' ? input.timeoutMs : 60_000,
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576,
          signal
        );
        if (result.exitCode !== 0) {
          const msg = `Command exited with ${result.exitCode}`;
          return {
            ok: false,
            message: msg,
            data: { ...result, ...target },
            error: { code: 'CONFLICT', message: msg, retryable: false },
            truncated: result.truncated
          };
        }
        return {
          ok: true,
          message: `Command exited with ${result.exitCode}`,
          data: { ...result, ...target },
          truncated: result.truncated
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'exec_run failed';
        return {
          ok: false,
          message: msg,
          error: { code: 'INVALID_INPUT', message: msg, retryable: false },
          truncated: false
        };
      }
    }

    if (operation === 'shell_open') {
      try {
        const record = await this.operationManager.openShell(
          this.workspaceId,
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey : 'default',
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576
        );
        return {
          ok: true,
          message: 'Shell opened',
          data: { shellId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'shell_open failed';
        return { ok: false, message: msg, error: { code: 'CONFLICT', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'shell_io') {
      try {
        const text = typeof input.input === 'string' ? input.input : '';
        this.operationManager.shellIo(this.workspaceId, String(input.shellId || ''), text);
        const record = this.operationManager.shellIo(this.workspaceId, String(input.shellId || ''));
        const result = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
        return {
          ok: true,
          message: 'Shell IO processed',
          data: result.data,
          cursor: result.cursor,
          truncated: result.truncated
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'shell_io failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'shell_close') {
      try {
        const record = this.operationManager.closeShell(this.workspaceId, String(input.shellId || ''));
        return {
          ok: true,
          message: 'Shell closed',
          data: { shellId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'shell_close failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_open') {
      try {
        const record = await this.operationManager.openSession(
          this.workspaceId,
          String(input.name || ''),
          typeof input.command === 'string' ? input.command : undefined,
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey : 'default',
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576
        );
        return {
          ok: true,
          message: 'Session started',
          data: { sessionId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'sessions_open failed';
        return { ok: false, message: msg, error: { code: 'CONFLICT', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_io') {
      try {
        const text = typeof input.input === 'string' ? input.input : '';
        this.operationManager.sessionIo(this.workspaceId, String(input.sessionId || ''), text);
        const record = this.operationManager.sessionIo(this.workspaceId, String(input.sessionId || ''));
        const result = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
        return {
          ok: true,
          message: 'Session output retrieved',
          data: result.data,
          cursor: result.cursor,
          truncated: result.truncated
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'sessions_io failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_close') {
      try {
        const record = this.operationManager.closeSession(this.workspaceId, String(input.sessionId || ''));
        return {
          ok: true,
          message: 'Session closed',
          data: { sessionId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'sessions_close failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_list') {
      const sessions = this.operationManager.listSessions(this.workspaceId);
      return {
        ok: true,
        message: `Found ${sessions.length} sessions`,
        data: { sessions: sessions.map((s) => this.operationManager.view(s)) },
        truncated: false
      };
    }

    if (operation === 'tasks_run') {
      try {
        const record = await this.operationManager.runTask(
          this.workspaceId,
          String(input.command || ''),
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey : 'default',
          typeof input.timeoutMs === 'number' ? input.timeoutMs : 60_000,
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576,
          Array.isArray(input.dependsOn) ? (input.dependsOn as string[]) : []
        );
        if (record.status === 'interrupted') {
          // A new task never starts interrupted: the key named a task from before a restart, which
          // is never re-run behind the caller's back, so say so instead of answering "queued".
          const msg = `task ${record.id} with this idempotencyKey was interrupted by a server restart; retry with a new idempotencyKey`;
          return {
            ok: false,
            message: msg,
            data: { taskId: record.id, status: record.status },
            error: { code: 'RUNNER_RESTARTED', message: msg, retryable: true },
            truncated: false
          };
        }
        return {
          ok: true,
          message: 'Task queued',
          data: { taskId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'tasks_run failed';
        return { ok: false, message: msg, error: { code: 'INVALID_INPUT', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'tasks_status') {
      try {
        const record = this.operationManager.task(this.workspaceId, String(input.taskId || ''));
        if (input.cursor !== undefined) {
          const result = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
          return {
            ok: true,
            message: 'Task status retrieved',
            data: result.data,
            cursor: result.cursor,
            truncated: result.truncated
          };
        }
        return {
          ok: true,
          message: 'Task status retrieved',
          data: this.operationManager.view(record),
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'tasks_status failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'tasks_cancel') {
      try {
        const record = this.operationManager.cancelTask(this.workspaceId, String(input.taskId || ''));
        return {
          ok: true,
          message: 'Task cancelled',
          data: { taskId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'tasks_cancel failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'tasks_list') {
      const tasks = this.operationManager.listTasks(this.workspaceId);
      return {
        ok: true,
        message: `Found ${tasks.length} tasks`,
        data: { tasks: tasks.map((t) => this.operationManager.view(t)) },
        truncated: false
      };
    }

    if (operation === 'tasks_graph') {
      const graph = this.operationManager.taskGraph(this.workspaceId);
      return {
        ok: true,
        message: 'Task graph retrieved',
        data: graph,
        truncated: false
      };
    }

    if (operation === 'git_fetch' || operation === 'git_pull') {
      if (!this.options.gitNetwork) {
        return {
          ok: false,
          message: 'network Git operations are disabled in local mode; pass --git-network to enable',
          error: {
            code: 'FORBIDDEN',
            message: 'network Git operations are disabled in local mode; pass --git-network to enable',
            retryable: false
          },
          truncated: false
        };
      }
    }

    if (operation.startsWith('worktrees_') && !isGitWorkTree(this.canonicalRoot)) {
      return unsupportedLocalResponse(operation, `the workspace root ${this.canonicalRoot} is not inside a Git work tree; run \`git worktree add\` through exec_run with cwd set to a repository inside the workspace`);
    }

    if (operation === 'git_push') {
      if (!this.options.gitPush) {
        return {
          ok: false,
          message: 'Git push operations are disabled in local mode; pass --git-push to enable',
          error: {
            code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED',
            message: 'Git push operations are disabled in local mode; pass --git-push to enable',
            retryable: false,
            operation: 'git_push',
            repository: `local://${this.canonicalRoot}`,
            requiredCapability: 'repository.push'
          },
          truncated: false
        };
      }
    }

    // The policy gates above answer first; an allowed git_pull/git_push still has no worker handler.
    const unimplemented = unimplementedLocalGitReason(operation);
    if (unimplemented) return unsupportedLocalResponse(operation, unimplemented);

    // Forward file, search, symbol, git, memory, hook, deployment operations to local worker
    return await this.workerClient.call(operation, input, signal);
  }

  /**
   * operation_status, operation_wait, and operation_cancel over this workspace's async exec_run and
   * bash handles, with the remote runner's response shapes and statuses.
   */
  private async callOperation(operation: 'operation_status' | 'operation_wait' | 'operation_cancel', input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    const operationId = String(input.operationId || '');
    let record: ReturnType<LocalOperationManager['operation']>;
    try {
      record = this.operationManager.operation(this.workspaceId, operationId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'operation not found';
      return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
    }

    if (operation === 'operation_cancel') {
      record = this.operationManager.cancelOperation(this.workspaceId, operationId);
      return {
        ok: true,
        message: 'Operation cancelled',
        data: { operationId: record.id, status: operationStatus(record.status) },
        truncated: false
      };
    }

    if (operation === 'operation_wait') {
      const timeoutMs = Math.min(typeof input.timeoutMs === 'number' ? input.timeoutMs : 60_000, OPERATION_WAIT_MAX_MS);
      const startTime = Date.now();
      record = await this.operationManager.waitOperation(this.workspaceId, operationId, timeoutMs, signal);
      const status = operationStatus(record.status);
      if (status === 'running' && signal?.aborted) {
        // The client went away before the deadline; that is not a timeout.
        return {
          ok: false,
          message: 'operation_wait aborted by the client',
          error: { code: 'CANCELLED', message: 'operation_wait aborted by the client; the operation keeps running', retryable: true },
          truncated: false
        };
      }
      if (status === 'running') {
        return {
          ok: false,
          message: 'Operation wait timed out',
          error: {
            code: 'TIMEOUT',
            message: 'Operation did not reach terminal state within timeout',
            retryable: true,
            retryAfterMs: 2000,
            deadline: new Date(startTime + timeoutMs).toISOString()
          },
          truncated: false
        };
      }
      const error = operationError(record);
      return {
        ok: status === 'completed',
        message: `Operation ${status}`,
        data: {
          operationId: record.id,
          status,
          result: this.operationResult(record),
          finishedAt: record.endedAt !== undefined ? new Date(record.endedAt).toISOString() : undefined
        },
        ...(error ? { error } : {}),
        truncated: false
      };
    }

    let page: ReturnType<LocalOperationManager['viewSince']>;
    try {
      page = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'invalid operation output cursor';
      return { ok: false, message: msg, error: { code: 'INVALID_INPUT', message: msg, retryable: false }, truncated: false };
    }
    const status = operationStatus(record.status);
    const error = operationError(record);
    // Truncated also when the oldest output was dropped (an async command keeps only its newest
    // maxOutputBytes), so a call without a cursor still learns it saw only the tail.
    const more = Number(page.cursor) < record.offset + record.output.length;
    const truncated = page.truncated || record.offset > 0;
    return {
      ok: status !== 'failed' && status !== 'cancelled',
      message: `Operation ${status}`,
      data: {
        operationId: record.id,
        status,
        kind: record.kind,
        createdAt: new Date(record.createdAt).toISOString(),
        deadline: record.startedAt !== undefined && record.timeoutMs ? new Date(record.startedAt + record.timeoutMs).toISOString() : undefined,
        finishedAt: record.endedAt !== undefined ? new Date(record.endedAt).toISOString() : undefined,
        ...(status === 'running' ? {} : { result: this.operationResult(record) }),
        output: page.data.output
      },
      ...(error ? { error } : {}),
      ...(more ? { cursor: page.cursor } : {}),
      truncated
    };
  }

  /** The same data a synchronous call returns; async output keeps the newest maxOutputBytes. */
  private operationResult(record: ReturnType<LocalOperationManager['operation']>): Record<string, unknown> {
    return {
      output: record.output.toString('utf8'),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.signal ? { signal: record.signal } : {}),
      truncated: record.offset > 0,
      ...(record.kind === 'bash' ? { target: 'workspace' } : {})
    };
  }
}

type OperationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

function operationStatus(status: string): OperationStatus {
  if (status === 'succeeded') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'running' || status === 'queued') return 'running';
  return 'failed';
}

function operationError(record: ReturnType<LocalOperationManager['operation']>): RunnerResponse['error'] | undefined {
  if (record.status === 'interrupted') {
    return { code: 'RUNNER_RESTARTED', message: 'the server restarted while this command was running; its output is lost, start it again', retryable: true };
  }
  if (record.status === 'cancelled') return { code: 'CANCELLED', message: 'Operation cancelled', retryable: false };
  if (record.status !== 'failed') return undefined;
  if (record.timedOut) return { code: 'TIMEOUT', message: 'Command execution exceeded its timeoutMs', retryable: false };
  const msg = `Command exited with ${record.exitCode ?? 1}`;
  return { code: 'CONFLICT', message: msg, retryable: false };
}
