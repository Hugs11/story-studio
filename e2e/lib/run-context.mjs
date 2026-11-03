// Contexte commun d'un parcours : dossier d'exécution, captures numérotées,
// étapes et verdict final écrit dans `result.json`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO_DIR, config } from './config.mjs';

export function createRun(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(config.workDir, 'runs', `${name}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 });
  const diff = git('diff', '--binary', 'HEAD');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', 'e2e').toString().split('\0').filter(Boolean);
  const untrackedSha256 = Object.fromEntries(untracked.map(path => [path,
    createHash('sha256').update(readFileSync(join(REPO_DIR, path))).digest('hex')]));
  const provenance = {
    head: git('rev-parse', 'HEAD').toString().trim(),
    diffSha256: createHash('sha256').update(diff).digest('hex'),
    args: process.argv.slice(2),
    untrackedSha256,
    status: git('status', '--porcelain=v1').toString(),
  };
  writeFileSync(join(runDir, 'code.diff'), diff);
  writeFileSync(join(runDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
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
