// Audit ponctuel : detecte les hooks customs (useXxx) et composants JSX (<Xxx>)
// utilises mais ni importes ni declares localement. Cible les fichiers passes
// en argument, ou les fichiers src/ touches par un range git.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
let files;
if (args.length > 0 && !args[0].startsWith('range:')) {
  files = args;
} else {
  const range = args[0]?.startsWith('range:') ? args[0].slice(6) : 'HEAD~1..HEAD';
  files = execSync(`git diff --name-only ${range}`)
    .toString()
    .split('\n')
    .filter((f) => /\.(js|jsx)$/.test(f) && f.startsWith('src/'));
}

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

const builtins = new Set([
  'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', 'useContext',
  'useLayoutEffect', 'useReducer', 'useImperativeHandle', 'useId', 'useTransition',
  'useDeferredValue', 'useSyncExternalStore', 'useInsertionEffect', 'useDebugValue',
  'Suspense', 'Fragment', 'StrictMode', 'Profiler',
]);

let problems = 0;
let scanned = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  scanned += 1;
  const src = strip(fs.readFileSync(f, 'utf8'));
  const imported = new Set();
  const importRe = /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))(?:\s*,\s*{([^}]+)})?\s+from/g;
  let m;
  while ((m = importRe.exec(src))) {
    for (const g of [m[1], m[4]]) {
      if (!g) continue;
      for (const p of g.split(',')) {
        const n = p.trim().replace(/.*\bas\s+/, '').trim();
        if (n) imported.add(n);
      }
    }
    if (m[2]) imported.add(m[2]);
    if (m[3]) imported.add(m[3]);
  }
  const locals = new Set();
  const localRe = /(?:export\s+)?(?:function|async\s+function|const|let|var)\s+(\w+)/g;
  while ((m = localRe.exec(src))) locals.add(m[1]);
  const destrRe = /(?:const|let|var)\s*[{[]([^}\]]+)[}\]]\s*=/g;
  while ((m = destrRe.exec(src))) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(/[:=]/)[0].trim().replace(/\.\.\./, '');
      if (n) locals.add(n);
    }
  }
  const used = new Set();
  const hookRe = /\b(use[A-Z]\w+)\s*\(/g;
  while ((m = hookRe.exec(src))) used.add(m[1]);
  const jsxRe = /<([A-Z]\w+)[\s/>]/g;
  while ((m = jsxRe.exec(src))) used.add(m[1]);

  const missing = [...used].filter((n) => !imported.has(n) && !locals.has(n) && !builtins.has(n));
  if (missing.length) {
    console.log(`MANQUANT  ${f} :: ${missing.join(', ')}`);
    problems += 1;
  }
}
console.log(problems === 0
  ? `OK : aucun hook/JSX manquant sur ${scanned} fichiers`
  : `${problems} fichier(s) a probleme`);
