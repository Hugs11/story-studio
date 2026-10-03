// Le panneau Réglages avancé doit activer les mêmes règles responsives que le
// panneau Libre, fondées sur sa largeur réelle.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const advancedCss = readFileSync(
  new URL('../src/components/AdvancedWorkspace/AdvancedWorkspace.css', import.meta.url),
  'utf8',
);
const editorCss = readFileSync(
  new URL('../src/components/editors/EditorPanel.css', import.meta.url),
  'utf8',
);

test('le panneau Réglages du graphe participe au conteneur responsive commun', () => {
  assert.match(
    advancedCss,
    /\.advanced-panel-slot--advanced-inspector\s*\{[^}]*container:\s*settings-panel\s*\/\s*inline-size;/s,
  );
  assert.match(
    editorCss,
    /@container settings-panel \(max-width: 760px\)[\s\S]*?\.editor-setting-row\.is-action-row[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
});
