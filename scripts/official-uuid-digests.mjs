import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const outputPath = fileURLToPath(new URL('../src-tauri/resources/official-uuid-digests.v1.bin', import.meta.url));
export function normalizeUuid(value) {
  if (typeof value !== 'string') return null;
  // Match uuid::Uuid::parse_str: canonical, simple, braced and UUID URN.
  let s = value;
  if (s.startsWith('urn:uuid:') && s.length === 45) s = s.slice(9);
  else if (s.length === 38 && s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(s)) return null;
  s = s.replaceAll('-', '').toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function validateDigests(bytes) {
  if (bytes.length % 32) throw new Error('Invalid digest file length');
  for (let i = 32; i < bytes.length; i += 32) {
    if (Buffer.compare(bytes.subarray(i - 32, i), bytes.subarray(i, i + 32)) >= 0) throw new Error('Digest order must be strictly increasing');
  }
  return bytes.length / 32;
}
export function buildDigests(payload) {
  const root = payload?.response ?? payload;
  if (!root || typeof root !== 'object' || Array.isArray(root) || !Object.keys(root).length || Object.keys(root).length > 20000) throw new Error('Invalid packs response');
  const digests = new Map();
  let invalid = 0;
  for (const pack of Object.values(root)) {
    const uuid = normalizeUuid(pack?.uuid);
    if (!uuid) { invalid++; continue; }
    const digest = createHash('sha256').update(`story-studio/official-uuid/v1:${uuid}`).digest();
    digests.set(digest.toString('hex'), digest);
  }
  return { bytes: Buffer.concat([...digests.values()].sort(Buffer.compare)), invalid };
}
async function getJson(url, max, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Official API unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('Response too large'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function main(args) {
  if (args.length === 2 && args[0] === '--check') {
    console.log(`Empreintes valides : ${validateDigests(await readFile(args[1]))}`);
    return;
  }
  if (args.length) throw new Error('Usage: official-uuid-digests.mjs [--check fichier]');
  let result;
  try {
    const auth = await getJson('https://server-auth-prod.lunii.com/guest/create', 64 * 1024);
    const token = auth?.response?.token?.server;
    if (typeof token !== 'string' || !token.length || token.length > 8192) throw new Error('Invalid token');
    result = buildDigests(await getJson('https://server-data-prod.lunii.com/v2/packs', 32 * 1024 * 1024, { 'X-AUTH-TOKEN': token }));
  } catch {
    console.error('API indisponible ou réponse invalide : fichier vide valide généré.');
    result = { bytes: Buffer.alloc(0), invalid: 0 };
    process.exitCode = 1;
  }
  await writeFile(outputPath, result.bytes);
  console.log(`Empreintes : ${validateDigests(result.bytes)} ; UUID invalides ignorés : ${result.invalid}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Échec du contrôle ou de l’écriture des empreintes.'); process.exitCode = 1; });
}
