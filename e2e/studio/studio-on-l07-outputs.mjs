// STUdio sur les zips conservés par le banc Rust `l07_campaign` (`SS_L07_KEEP_DIR`,
// `src-tauri/src/native_pack/tests/l07_campaign.rs`) : vérifie que chaque
// archive produite deux fois par la chaîne Libre passe l'oracle STUdio
// (`studioVerdict`), sans lancer l'app — aucun CDP, aucune WebView2, aucun
// `tauri dev`. Complète le contrôle de déterminisme déjà écrit par ce banc
// (octets identiques) par l'acceptation STUdio sur les mêmes sorties.
//
// Usage : node e2e/studio/studio-on-l07-outputs.mjs [dossier]
// Dossier par défaut : SS_L07_KEEP_DIR.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import { studioVerdict } from './studio.mjs';

function zipsIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.zip'))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

// Passe STUdio sur chaque zip du dossier, renvoie un verdict par fichier plus
// un total. N'écrit rien dans `dir` (lecture seule) : chaque conversion sort
// dans un sous-dossier de `config.workDir`, distinct par fichier et par appel.
export function studioOnKeepDir(dir) {
  const zips = zipsIn(dir);
  const results = zips.map((zip) => {
    const outDir = join(config.workDir, 'studio-l07-out', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return { zip, verdict: studioVerdict(zip, outDir) };
  });
  const failed = results.filter(({ verdict }) => !verdict.ok);
  return { total: results.length, failed: failed.length, results };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const dir = process.argv[2] || process.env.SS_L07_KEEP_DIR;
  if (!dir) {
    console.error('Usage : node e2e/studio/studio-on-l07-outputs.mjs <dossier> (ou SS_L07_KEEP_DIR)');
    process.exit(1);
  }
  const { total, failed, results } = studioOnKeepDir(dir);
  for (const { zip, verdict } of results) {
    console.log(`${verdict.ok ? 'OK' : 'KO'}  ${zip}`);
    if (!verdict.ok) console.log(`   ${verdict.detail ?? verdict.convert}`);
  }
  console.log(`\n${total - failed}/${total} OK`);
  process.exit(failed > 0 ? 1 : 0);
}
