import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_JITTER_RATIO = 0.2;
const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorDetails(error) {
  const details = [error?.message || String(error)];
  if (error?.cause?.code) details.push(error.cause.code);
  if (error?.cause?.message && error.cause.message !== error.message) {
    details.push(error.cause.message);
  }
  return [...new Set(details)].join(' — ');
}

function isTransient(error) {
  return error?.transient === true
    || error instanceof TypeError
    || ['AbortError', 'TimeoutError'].includes(error?.name)
    || TRANSIENT_NETWORK_CODES.has(error?.code)
    || TRANSIENT_NETWORK_CODES.has(error?.cause?.code);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}

function hostAllowed(hostname, allowedHosts) {
  if (typeof allowedHosts === 'function') return allowedHosts(hostname);
  return allowedHosts.includes(hostname);
}

function assertTrustedUrl(url, label, allowedHosts, context = 'URL') {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} ${context} must use HTTPS.`);
  }
  if (!hostAllowed(parsed.hostname, allowedHosts)) {
    throw new Error(`${label} ${context} host is not allowed.`);
  }
  return parsed;
}

function cacheName(spec) {
  const urlName = basename(new URL(spec.url).pathname) || 'download';
  const safeName = urlName.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return `${spec.sha256}-${safeName}`;
}

export function verifiedDownloadCachePath(spec, cacheDir) {
  return join(cacheDir, cacheName(spec));
}

async function readVerifiedCache(spec, label, cacheDir) {
  if (!cacheDir) return null;
  const path = verifiedDownloadCachePath(spec, cacheDir);
  try {
    const bytes = await readFile(path);
    if (bytes.length <= spec.maxBytes && sha256(bytes) === spec.sha256) {
      process.stdout.write(`Using verified download cache for ${label}.\n`);
      return bytes;
    }
    await rm(path, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return null;
}

async function writeVerifiedCache(spec, cacheDir, bytes) {
  if (!cacheDir) return;
  await mkdir(cacheDir, { recursive: true });
  const destination = verifiedDownloadCachePath(spec, cacheDir);
  const temporary = `${destination}.downloading-${randomUUID()}`;
  await writeFile(temporary, bytes);
  try {
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function downloadOnce(spec, label, {
  allowedHosts,
  fetchImpl,
  timeoutMs,
  userAgent,
}) {
  const response = await fetchImpl(spec.url, {
    headers: userAgent ? { 'User-Agent': userAgent } : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    const error = new Error(`${label} download failed with HTTP ${response.status}.`);
    error.transient = response.status === 408
      || response.status === 429
      || response.status >= 500;
    throw error;
  }
  assertTrustedUrl(response.url || spec.url, label, allowedHosts, 'redirected URL');
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > spec.maxBytes) {
    throw new Error(`${label} exceeds its declared size limit.`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > spec.maxBytes) {
      throw new Error(`${label} exceeded its size limit.`);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw new Error(`${label} has an invalid size.`);
  if (sha256(bytes) !== spec.sha256) {
    throw new Error(`${label} SHA-256 mismatch.`);
  }
  return bytes;
}

export async function verifiedDownload(spec, label, {
  allowedHosts,
  cacheDir,
  fetchImpl = fetch,
  jitterRatio = DEFAULT_JITTER_RATIO,
  random = Math.random,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userAgent,
  waitForRetry = wait,
} = {}) {
  if (!allowedHosts || (Array.isArray(allowedHosts) && !allowedHosts.length)) {
    throw new Error(`${label} requires an allowed host policy.`);
  }
  if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes <= 0) {
    throw new Error(`${label} requires a positive size limit.`);
  }
  if (!/^[a-f0-9]{64}$/.test(spec.sha256)) {
    throw new Error(`${label} requires a pinned SHA-256.`);
  }
  assertTrustedUrl(spec.url, label, allowedHosts);

  const cached = await readVerifiedCache(spec, label, cacheDir);
  if (cached) return cached;

  process.stdout.write(`Downloading ${label}…\n`);
  const maxAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const bytes = await downloadOnce(spec, label, {
        allowedHosts,
        fetchImpl,
        timeoutMs,
        userAgent,
      });
      await writeVerifiedCache(spec, cacheDir, bytes);
      return bytes;
    } catch (error) {
      const details = errorDetails(error);
      if (!isTransient(error) || attempt === maxAttempts) {
        const attemptSummary = attempt > 1 ? ` after ${attempt} attempts` : '';
        throw new Error(`${label} download failed${attemptSummary}: ${details}`, {
          cause: error,
        });
      }
      const baseDelay = retryDelaysMs[attempt - 1];
      const jitter = baseDelay * jitterRatio * ((random() * 2) - 1);
      const delay = Math.max(0, Math.round(baseDelay + jitter));
      process.stdout.write(
        `${label} download attempt ${attempt}/${maxAttempts} failed: ${details}. `
        + `Retrying in ${delay} ms…\n`,
      );
      await waitForRetry(delay);
    }
  }
  throw new Error(`${label} download failed: no download attempt was configured.`);
}

export const VERIFIED_DOWNLOAD_DEFAULTS = {
  retryDelaysMs: [...DEFAULT_RETRY_DELAYS_MS],
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
