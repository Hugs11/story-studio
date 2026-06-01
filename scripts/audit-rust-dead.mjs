// Audit ponctuel : fonctions Rust pub(crate)/pub(super)/pub(in ...) dont le
// nom n'apparait qu'une fois dans tout src-tauri/src (= definition seule,
// jamais appelees). Le compilateur ne warn pas le dead code pour ces
// visibilites. Faux positifs : commandes Tauri (invoke), trait impls,
// fonctions appelees via macro.
import fs from 'node:fs';
import path from 'node:path';

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'target') continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.rs')) files.push(f);
  }
})('src-tauri/src');

const all = files.map((f) => fs.readFileSync(f, 'utf8'));
const allText = all.join('\n');

// Commandes Tauri (appelees par nom via invoke cote JS) : a exclure
const tauriCommands = new Set();
for (const src of all) {
  const re = /#\[tauri::command\][\s\S]{0,80}?fn\s+(\w+)/g;
  let m;
  while ((m = re.exec(src))) tauriCommands.add(m[1]);
}

const dead = [];
for (let i = 0; i < files.length; i++) {
  const src = all[i];
  const re = /pub\((?:crate|super|in [^)]+)\)\s+(?:async\s+)?fn\s+(\w+)/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (tauriCommands.has(name)) continue;
    // Compte les occurrences du nom dans tout le code
    const occ = (allText.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
    if (occ <= 1) dead.push({ name, file: files[i] });
  }
}

if (dead.length === 0) {
  console.log('OK : aucune fonction pub(crate)/pub(super) morte detectee.');
} else {
  console.log(`${dead.length} fonction(s) Rust pub(crate)/pub(super) candidate(s) au dead code :`);
  for (const d of dead) console.log(`  ${d.name}  <-  ${d.file}`);
}
