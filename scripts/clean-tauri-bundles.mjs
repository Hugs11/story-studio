import { lstat, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_SEGMENTS = ['src-tauri', 'target', 'release', 'bundle'];

export function resolveTauriBundleDir(workspaceRoot) {
  const root = resolve(workspaceRoot);
  const bundleDir = resolve(root, ...BUNDLE_SEGMENTS);
  const expectedRelative = BUNDLE_SEGMENTS.join('/');
  const actualRelative = relative(root, bundleDir).replaceAll('\\', '/');
  if (actualRelative !== expectedRelative) {
    throw new Error(`Refus de nettoyer un chemin de bundle inattendu : ${bundleDir}`);
  }
  return bundleDir;
}

export async function cleanTauriBundleDir(workspaceRoot) {
  const bundleDir = resolveTauriBundleDir(workspaceRoot);
  let metadata;
  try {
    metadata = await lstat(bundleDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { bundleDir, removed: false };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refus de nettoyer un bundle non régulier : ${bundleDir}`);
  }
  await rm(bundleDir, { recursive: true, force: false });
  return { bundleDir, removed: true };
}

async function main() {
  const result = await cleanTauriBundleDir(process.cwd());
  console.log(result.removed
    ? `Anciens bundles Tauri supprimés : ${result.bundleDir}`
    : `Aucun ancien bundle Tauri : ${result.bundleDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
