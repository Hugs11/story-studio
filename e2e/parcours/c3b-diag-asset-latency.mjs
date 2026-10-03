// Diagnostic ponctuel : mesurer directement la latence de `get_pack_asset`
// (IPC) sur un petit et un gros asset d'une archive déjà produite, pour
// distinguer un problème de performance (marshalling d'un gros Vec<u8> en JSON
// sur l'IPC Tauri) d'un vrai blocage applicatif. Aucune UI : invoke direct.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';

// `node e2e/run.mjs c3b-diag-asset-latency` argv : [.., parcours, zip, small, big]
const ZIP_PATH = process.argv[3];
const SMALL_ASSET = process.argv[4];
const BIG_ASSET = process.argv[5];

export async function run() {
  const ctx = createRun('c3b-diag-asset-latency');
  const app = await launchApp({ runDir: ctx.runDir, fresh: false, workspaceDir: ctx.dir('workspace') });
  try {
    for (const [label, asset] of [['petit', SMALL_ASSET], ['gros', BIG_ASSET]]) {
      let ms = null;
      let byteLength = null;
      let binaryResponse = false;
      let error = null;
      try {
        ({ ms, byteLength, binaryResponse } = await app.page.evaluate(async ([zipPath, assetName]) => {
          const startedAt = performance.now();
          const bytes = await window.__TAURI_INTERNALS__.invoke('get_pack_asset', { zipPath, assetName });
          return {
            ms: Math.round(performance.now() - startedAt),
            byteLength: bytes instanceof ArrayBuffer ? bytes.byteLength : bytes?.length ?? null,
            binaryResponse: bytes instanceof ArrayBuffer,
          };
        }, [ZIP_PATH, asset]));
      } catch (e) {
        error = String(e?.message ?? e);
      }
      ctx.check(
        `get_pack_asset(${label}: ${asset}) : durée = ${ms}ms`,
        error === null && binaryResponse && ms < 1000,
        { ms, byteLength, binaryResponse, error },
      );
    }
  } finally {
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
