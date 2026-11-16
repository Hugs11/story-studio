import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
// Les fragments évitent que la définition des motifs se détecte elle-même.
const patterns = [
  ['décision', ' Hugs'].join(''),
  ['orches', 'trateur'].join(''),
  String.fromCodePoint(0x1f64b),
  ['H10', 'b'].join(''),
  ['super', 'boki'].join(''),
];
const forbidden = new RegExp(patterns.join('|'), 'iu');

// Ces deux commentaires appartiennent à une source historique utilisée comme
// oracle d'équivalence. Seuls ces textes exacts sont tolérés dans cette fixture.
const historicalComments = [
  '// Extraite de TreePanel.jsx pour reduire la surface du composant ' + patterns[1] + '.',
  "// Extrait de FullDiagramTree.jsx pour reduire la surface de l'" + patterns[1] + '.',
];

test('les fichiers suivis ne contiennent pas de traces internes', async () => {
  const { stdout } = await runFile('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const files = stdout.split('\0').filter(Boolean);
  const violations = [];
  for (const path of files) {
    if (path.startsWith('Documentation/') || path.startsWith('src-tauri/tools/')
      || /(?:^|\/)(?:licenses?|notices?)(?:\/|[._-]|$)/i.test(path)
      || /(?:^|\/)THIRD_PARTY_[^/]+/i.test(path)) continue;
    const bytes = readFileSync(new URL('../' + path, import.meta.url));
    if (bytes.includes(0)) continue;
    let content = bytes.toString('utf8');
    if (path === 'scripts/fixtures/tree-diagram-fr-base-sources.json') {
      for (const comment of historicalComments) content = content.replace(comment, '');
    }
    for (const [index, line] of content.split('\n').entries()) {
      if (forbidden.test(line)) violations.push(`${path}:${index + 1}`);
    }
  }
  assert.deepEqual(violations, [], `Traces internes :\n${violations.join('\n')}`);
});
