import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { WorkspaceIdSchema, type ErrorCode, type RunnerResponse } from '@cloud-harness/contracts';
import type { BackendTool } from '../operation-backend.js';
import type { LocalPathPolicy } from './local-path-policy.js';

/**
 * `files_import`: the client hands the server files by reference (the OpenAI Apps SDK
 * `openai/fileParams` feature), so image bytes never travel inside a tool call. ChatGPT replaces
 * each listed argument with `{ download_url, file_id, mime_type?, file_name? }`; the server
 * downloads the temporary URL into the workspace. The URL is a capability: it is never logged and
 * never echoed in a result or an error message.
 */
export const FILES_IMPORT_TOOL = 'files_import';
export const FILE_IMPORT_MAX_FILES = 16;
export const DEFAULT_IMPORT_MAX_FILE_BYTES = 52_428_800;
const IMPORT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_NAME_LENGTH = 255;
/** Enables plain-HTTP downloads from this host only (tests); any other HTTP URL is still refused. */
export const IMPORT_LOOPBACK_HTTP_ENV = 'CLOUD_HARNESS_FILE_IMPORT_ALLOW_LOOPBACK_HTTP';

export const LOCAL_FILE_IMPORT_GUIDANCE = 'To give the server an image you generated or the user uploaded, call files_import with the image as a file; never paste base64 into files_write or a command. ';

export type FileImportSettings = {
  /** Largest file accepted, enforced while the body streams. */
  maxFileBytes: number;
  /** Accept `http:` URLs whose host is 127.0.0.1, ::1, or localhost. Off outside tests. */
  allowLoopbackHttp: boolean;
};

export function defaultFileImportSettings(env: NodeJS.ProcessEnv = process.env): FileImportSettings {
  return { maxFileBytes: DEFAULT_IMPORT_MAX_FILE_BYTES, allowLoopbackHttp: env[IMPORT_LOOPBACK_HTTP_ENV] === '1' };
}

// The Apps SDK requires all four properties declared, download_url and file_id required. Unknown
// properties ChatGPT may add later are accepted and ignored.
export const FileRefSchema = z.looseObject({
  download_url: z.string().min(1).max(16_384).describe('Temporary download URL, filled in by the client'),
  file_id: z.string().min(1).max(512).describe('Client file identifier'),
  mime_type: z.string().max(255).optional().describe('MIME type reported by the client'),
  file_name: z.string().max(1_024).optional().describe('Original file name')
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const FilesImportInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  dir: z.string().min(1).max(1_024).describe('Destination directory, relative to the workspace root or absolute inside it; created when missing'),
  files: z.array(FileRefSchema).min(1).max(FILE_IMPORT_MAX_FILES).describe('Files to import: attach the image itself, never base64 text'),
  names: z.array(z.string().min(1).max(MAX_NAME_LENGTH)).min(1).max(FILE_IMPORT_MAX_FILES).optional()
    .describe('Target file names in the same order as files; default: the sanitized file_name, else file_id plus an extension from the MIME type'),
  overwrite: z.boolean().default(false).describe('Replace existing files; otherwise an existing name fails with EXISTS')
}).superRefine((input, context) => {
  if (input.names && input.names.length !== input.files.length) {
    context.addIssue({ code: 'custom', path: ['names'], message: 'names must have one entry per file' });
  }
});
export type FilesImportInput = z.infer<typeof FilesImportInputSchema>;

export const FILES_IMPORT_TOOL_SPEC: BackendTool = {
  name: FILES_IMPORT_TOOL,
  title: 'Import files',
  description: 'Download files the client passes by reference (an image you generated or the user uploaded) into a workspace directory. '
    + 'Pass the file itself in files, never base64. Each file is fetched over HTTPS, capped in size, written atomically, and reported with path, bytes, sha256, and MIME type; '
    + 'failures are reported per file.',
  inputSchema: FilesImportInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: { 'openai/fileParams': ['files'] }
};

export type ImportErrorCode =
  | 'INVALID_URL' | 'INSECURE_URL' | 'HTTP_ERROR' | 'TOO_MANY_REDIRECTS' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED'
  | 'TOO_LARGE' | 'INVALID_NAME' | 'DUPLICATE_NAME' | 'EXISTS' | 'WRITE_FAILED';

export type ImportedFile = { index: number; file_id: string; ok: true; path: string; bytes: number; sha256: string; mime: string };
export type FailedImport = { index: number; file_id: string; ok: false; error: { code: ImportErrorCode; message: string; retryable: boolean } };
export type ImportOutcome = ImportedFile | FailedImport;

class ImportError extends Error {
  constructor(readonly code: ImportErrorCode, message: string, readonly retryable = false) {
    super(message);
  }
}

const TOOL_ERROR_CODE: Record<ImportErrorCode, ErrorCode> = {
  INVALID_URL: 'INVALID_INPUT', INSECURE_URL: 'INVALID_INPUT', INVALID_NAME: 'INVALID_INPUT',
  HTTP_ERROR: 'UNAVAILABLE', TOO_MANY_REDIRECTS: 'UNAVAILABLE', NETWORK_ERROR: 'UNAVAILABLE',
  TIMEOUT: 'TIMEOUT', CANCELLED: 'CANCELLED', TOO_LARGE: 'LIMIT_EXCEEDED',
  DUPLICATE_NAME: 'CONFLICT', EXISTS: 'CONFLICT', WRITE_FAILED: 'INTERNAL_ERROR'
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'image/avif': '.avif', 'image/heic': '.heic', 'application/pdf': '.pdf', 'text/plain': '.txt', 'application/json': '.json'
};

const GENERIC_MIME = new Set(['application/octet-stream', 'binary/octet-stream', 'application/binary']);

function failure(code: ErrorCode, message: string, data?: unknown): RunnerResponse {
  return { ok: false, message, error: { code, message, retryable: false }, ...(data !== undefined ? { data } : {}), truncated: false };
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** The PNG, JPEG, WebP, or GIF type the leading bytes prove, if any. */
export function sniffImageMime(head: Uint8Array): string | undefined {
  const starts = (bytes: number[], offset = 0) => bytes.every((value, index) => head[offset + index] === value);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

function normalizeMime(value: string | null | undefined): string | undefined {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  return type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : undefined;
}

/** A single path segment that cannot climb, hide a separator, or carry control characters. */
function validName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && name !== '.' && name !== '..'
    && !/[/\\]/.test(name) && ![...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}

function sanitizeName(raw: string): string {
  const base = raw.replaceAll('\\', '/').split('/').pop() ?? '';
  return base.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').replace(/_+/g, '_').slice(0, 128);
}

/** Default name: the sanitized file_name, else the file_id with an extension from the MIME type. */
function defaultName(ref: FileRef, mime: string): string {
  const fromName = ref.file_name ? sanitizeName(ref.file_name) : '';
  if (fromName && /[A-Za-z0-9]/.test(fromName)) {
    return /\.[A-Za-z0-9]{1,8}$/.test(fromName) ? fromName : `${fromName}${EXTENSION_BY_MIME[mime] ?? ''}`;
  }
  const id = sanitizeName(ref.file_id) || 'file';
  return `${id}${EXTENSION_BY_MIME[mime] ?? ''}`;
}

function checkUrl(raw: string, settings: FileImportSettings): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportError('INVALID_URL', 'download_url is not a valid absolute URL');
  }
  if (url.protocol === 'https:') return url;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && loopback && settings.allowLoopbackHttp) return url;
  throw new ImportError('INSECURE_URL', `download_url must use https (got ${url.protocol.replace(':', '')})`);
}

/** Fetches with redirects followed by hand, so every hop passes the same scheme rule. */
async function fetchFollowing(raw: string, settings: FileImportSettings, signal: AbortSignal): Promise<Response> {
  let url = checkUrl(raw, settings);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal, headers: { accept: '*/*' } });
    } catch (error) {
      throw networkError(error, signal);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new ImportError('TOO_MANY_REDIRECTS', `more than ${MAX_REDIRECTS} redirects`);
      let next: string;
      try {
        next = new URL(response.headers.get('location')!, url).href;
      } catch {
        throw new ImportError('INVALID_URL', 'redirect target is not a valid URL');
      }
      url = checkUrl(next, settings);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryable = response.status === 429 || response.status >= 500;
      const hint = response.status === 403 || response.status === 404 || response.status === 410 ? '; the download URL may have expired, attach the file again' : '';
      throw new ImportError('HTTP_ERROR', `download failed with HTTP ${response.status}${hint}`, retryable);
    }
    return response;
  }
}

function networkError(error: unknown, signal: AbortSignal): ImportError {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    return reason instanceof DOMException && reason.name === 'TimeoutError'
      ? new ImportError('TIMEOUT', `download did not finish within ${IMPORT_TIMEOUT_MS / 1000} s`, true)
      : new ImportError('CANCELLED', 'download cancelled');
  }
  if (error instanceof ImportError) return error;
  // Only the errno-style code is reported: fetch messages can quote the URL.
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return new ImportError('NETWORK_ERROR', `download failed${typeof cause === 'string' && /^[A-Z0-9_]+$/.test(cause) ? ` (${cause})` : ''}`, true);
}

type Downloaded = { tmp: string; bytes: number; sha256: string; mime: string };

/** Streams one file into a temporary file in `dir`, hashing it and enforcing the size cap. */
async function download(ref: FileRef, dir: string, settings: FileImportSettings, parent?: AbortSignal): Promise<Downloaded> {
  const signals = [AbortSignal.timeout(IMPORT_TIMEOUT_MS), ...(parent ? [parent] : [])];
  const signal = AbortSignal.any(signals);
  const response = await fetchFollowing(ref.download_url, settings, signal);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > settings.maxFileBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImportError('TOO_LARGE', `file is ${declared} bytes, above the ${settings.maxFileBytes}-byte limit`);
  }
  const tmp = join(dir, `.files-import-${randomBytes(9).toString('base64url')}.tmp`);
  const handle = await open(tmp, 'wx', 0o644).catch(async (error: unknown) => {
    await response.body?.cancel().catch(() => undefined);
    throw new ImportError('WRITE_FAILED', `cannot create a temporary file: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  });
  const hash = createHash('sha256');
  let bytes = 0;
  let head = new Uint8Array(0);
  let completed = false;
  try {
    if (response.body) {
      try {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          if (bytes > settings.maxFileBytes) {
            throw new ImportError('TOO_LARGE', `file exceeds the ${settings.maxFileBytes}-byte limit`);
          }
          if (head.byteLength < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.byteLength)]);
          hash.update(chunk);
          await handle.write(chunk);
        }
      } catch (error) {
        if (error instanceof ImportError) {
          await response.body.cancel().catch(() => undefined);
          throw error;
        }
        if ((error as NodeJS.ErrnoException | undefined)?.syscall === 'write') {
          throw new ImportError('WRITE_FAILED', `write failed: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
        }
        throw networkError(error, signal);
      }
    }
    completed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!completed) await unlink(tmp).catch(() => undefined);
  }
  const headerMime = normalizeMime(response.headers.get('content-type'));
  const mime = sniffImageMime(head)
    ?? (headerMime && !GENERIC_MIME.has(headerMime) ? headerMime : undefined)
    ?? normalizeMime(ref.mime_type)
    ?? 'application/octet-stream';
  return { tmp, bytes, sha256: hash.digest('hex'), mime };
}

/** Moves the finished temporary file onto its name; without overwrite an existing name wins. */
async function commit(tmp: string, target: string, overwrite: boolean): Promise<void> {
  try {
    if (overwrite) {
      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isDirectory()) throw new ImportError('EXISTS', 'a directory already has this name');
      await rename(tmp, target);
      return;
    }
    try {
      // link() fails with EEXIST instead of replacing, so the existence check cannot race.
      await link(tmp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new ImportError('EXISTS', 'a file with this name already exists; pass overwrite: true or another name');
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw error;
      // Filesystems without hard links: check, then rename.
      if (await lstat(target).then(() => true, () => false)) throw new ImportError('EXISTS', 'a file with this name already exists; pass overwrite: true or another name');
      await rename(tmp, target);
      return;
    }
    await unlink(tmp).catch(() => undefined);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    if (error instanceof ImportError) throw error;
    throw new ImportError('WRITE_FAILED', `cannot write the file: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

/** Resolves `dir` inside the root (relative, or absolute under it), creating it when missing. */
async function resolveDirectory(policy: LocalPathPolicy, dir: string): Promise<string> {
  let relativeDir = dir.replaceAll('\\', '/');
  if (isAbsolute(dir)) {
    const rel = relative(policy.canonicalRoot, resolve(dir));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path escapes workspace');
    relativeDir = rel === '' ? '.' : rel.split(sep).join('/');
  }
  relativeDir = relativeDir.replace(/\/+$/, '') || '.';
  if (relativeDir === '.' || relativeDir === './') return policy.canonicalRoot;
  const candidate = await policy.safeRecursiveCreatePath(relativeDir);
  await mkdir(candidate, { recursive: true });
  const actual = await realpath(candidate);
  if (!isInside(policy.canonicalRoot, actual)) throw new Error('path escapes workspace');
  if (!(await stat(actual)).isDirectory()) throw new Error('destination is not a directory');
  return actual;
}

export async function importFiles(policy: LocalPathPolicy, input: FilesImportInput, settings: FileImportSettings, signal?: AbortSignal): Promise<RunnerResponse> {
  let dir: string;
  try {
    dir = await resolveDirectory(policy, input.dir);
  } catch (error) {
    const message = error instanceof Error && /escapes workspace|not a directory|unavailable/.test(error.message)
      ? `dir ${error.message}`
      : `dir cannot be created: ${(error as NodeJS.ErrnoException).code ?? 'error'}`;
    return failure('INVALID_INPUT', message);
  }

  const claimed = new Set<string>();
  const overwrite = input.overwrite ?? false;
  const importOne = async (ref: FileRef, index: number): Promise<ImportOutcome> => {
    try {
      const explicit = input.names?.[index];
      if (explicit !== undefined && !validName(explicit)) {
        throw new ImportError('INVALID_NAME', 'names entries must be plain file names without separators, "..", or control characters');
      }
      const downloaded = await download(ref, dir, settings, signal);
      const name = explicit ?? defaultName(ref, downloaded.mime);
      if (claimed.has(name)) {
        await unlink(downloaded.tmp).catch(() => undefined);
        throw new ImportError('DUPLICATE_NAME', `another file in this call is already named ${name}`);
      }
      claimed.add(name);
      const target = join(dir, name);
      await commit(downloaded.tmp, target, overwrite);
      return {
        index, file_id: ref.file_id, ok: true,
        path: relative(policy.canonicalRoot, target).split(sep).join('/'),
        bytes: downloaded.bytes, sha256: downloaded.sha256, mime: downloaded.mime
      };
    } catch (error) {
      const failed = error instanceof ImportError ? error : new ImportError('WRITE_FAILED', 'import failed');
      return { index, file_id: ref.file_id, ok: false, error: { code: failed.code, message: failed.message, retryable: failed.retryable } };
    }
  };

  const results: ImportOutcome[] = new Array<ImportOutcome>(input.files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, input.files.length) }, async () => {
    while (next < input.files.length) {
      const index = next++;
      results[index] = await importOne(input.files[index]!, index);
    }
  }));

  const imported = results.filter((result) => result.ok).length;
  const failedResults = results.filter((result): result is FailedImport => !result.ok);
  const relativeDir = relative(policy.canonicalRoot, dir).split(sep).join('/') || '.';
  const data = { dir: relativeDir, imported, failed: failedResults.length, files: results };
  if (imported === 0) {
    const first = failedResults[0]!.error;
    const message = `No file imported: ${failedResults.map((result) => `#${result.index} ${result.error.code}: ${result.error.message}`).join('; ')}`.slice(0, 2_000);
    return { ok: false, message, error: { code: TOOL_ERROR_CODE[first.code], message, retryable: first.retryable }, data, truncated: false };
  }
  const message = failedResults.length === 0
    ? `Imported ${imported} file${imported === 1 ? '' : 's'} into ${relativeDir}`
    : `Imported ${imported} of ${results.length} files into ${relativeDir}; ${failedResults.length} failed (${failedResults.map((result) => `#${result.index} ${result.error.code}`).join(', ')})`;
  return { ok: true, message, data, truncated: false };
}
