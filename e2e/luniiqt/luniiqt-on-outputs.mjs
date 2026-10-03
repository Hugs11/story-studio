// Oracle Lunii.QT sur tous les `.zip` d'un dossier (récursif), sans lancer l'app.
// Écrit un jsonl (une ligne par archive) et affiche un résumé.
//
// Usage : node e2e/luniiqt/luniiqt-on-outputs.mjs <dossier> [sortie.jsonl]
// Sortie par défaut : <workDir>/luniiqt-out/verdicts-<horodatage>.jsonl
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import { luniiqtVerdict } from './luniiqt.mjs';

function zipsUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...zipsUnder(path));
    else if (name.toLowerCase().endsWith('.zip')) found.push(path);
  }
  return found;
}

export function luniiqtOnDir(dir) {
  const results = zipsUnder(dir).map((zip) => ({ zip, verdict: luniiqtVerdict(zip) }));
  const failed = results.filter(({ verdict }) => !verdict.ok).length;
  return { total: results.length, failed, results };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage : node e2e/luniiqt/luniiqt-on-outputs.mjs <dossier> [sortie.jsonl]');
    process.exit(1);
  }
  const out = process.argv[3] || join(config.workDir, 'luniiqt-out', `verdicts-${Date.now()}.jsonl`);
  mkdirSync(join(out, '..'), { recursive: true });
  const { total, failed, results } = luniiqtOnDir(dir);
  writeFileSync(out, results.map(({ zip, verdict }) => JSON.stringify({ zip, ...verdict })).join('\n') + '\n');
  for (const { zip, verdict } of results) {
    console.log(`${verdict.ok ? 'OK' : 'KO'}  ${zip}`);
    if (!verdict.ok) console.log(`   ${(verdict.errors || []).join(' | ')}`);
  }
  console.log(`\n${total - failed}/${total} OK — ${out}`);
  process.exit(failed > 0 ? 1 : 0);
}
