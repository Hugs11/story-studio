// Contexte commun d'un parcours : dossier d'exécution, captures numérotées,
// étapes et verdict final écrit dans `result.json`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

export function createRun(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(config.workDir, 'runs', `${name}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const steps = [];
  let shots = 0;
  return {
    name,
    runDir,
    steps,
    dir(...parts) {
      const path = join(runDir, ...parts);
      mkdirSync(path, { recursive: true });
      return path;
    },
    async shot(page, label) {
      shots += 1;
      const file = `${String(shots).padStart(3, '0')}-${label}.png`;
      await page.screenshot({ path: join(runDir, file) });
      return file;
    },
    // Une étape = un fait vérifié. `ok: null` signifie « non exécuté ».
    check(label, ok, detail = {}) {
      steps.push({ label, ok, ...detail });
      const mark = ok === true ? 'OK ' : ok === false ? 'KO ' : '-- ';
      console.log(`${mark} ${label}`);
      return ok;
    },
    finish(extra = {}) {
      const failed = steps.filter(step => step.ok === false);
      const result = { name, runDir, passed: failed.length === 0, failed: failed.map(step => step.label), steps, ...extra };
      writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(`\n${result.passed ? 'PARCOURS OK' : `PARCOURS KO (${failed.length})`} — ${runDir}`);
      return result;
    },
  };
}
