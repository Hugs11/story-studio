import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const creditsSource = await readFile(
  new URL('../src/components/common/CreditsModal.jsx', import.meta.url),
  'utf8',
);
const titleBarSource = await readFile(
  new URL('../src/components/layout/TitleBar.jsx', import.meta.url),
  'utf8',
);
const modeSelectorSource = await readFile(
  new URL('../src/components/ModeSelector/ModeSelector.jsx', import.meta.url),
  'utf8',
);
const appShellSource = await readFile(
  new URL('../src/components/AppShell.jsx', import.meta.url),
  'utf8',
);
const defaultCapability = JSON.parse(await readFile(
  new URL('../src-tauri/capabilities/default.json', import.meta.url),
  'utf8',
));

test('la modale À propos route la documentation selon le runtime', () => {
  assert.match(
    creditsSource,
    /const DOCUMENTATION_URL = 'https:\/\/hugs11\.github\.io\/story-studio\/docs\/'/,
  );
  assert.match(creditsSource, /if \(!isTauriRuntime\(\)\) return;/);
  assert.match(creditsSource, /await openUrl\(DOCUMENTATION_URL\);/);
  assert.match(creditsSource, /href=\{DOCUMENTATION_URL\}/);
  assert.match(creditsSource, /target="_blank"/);
  assert.match(creditsSource, /rel="noopener noreferrer"/);
  assert.match(creditsSource, /Documentation inaccessible/);
});

test('le bouton d’aide et la permission opener restent accessibles', () => {
  assert.match(titleBarSource, /aria-label="Aide et à propos"/);
  assert.ok(defaultCapability.permissions.includes('opener:default'));
});

test('l’accueil propose un accès direct à la documentation', () => {
  assert.match(
    modeSelectorSource,
    /const DOCUMENTATION_URL = 'https:\/\/hugs11\.github\.io\/story-studio\/docs\/'/,
  );
  assert.match(modeSelectorSource, /await openUrl\(DOCUMENTATION_URL\);/);
  assert.match(modeSelectorSource, /href=\{DOCUMENTATION_URL\}/);
  assert.match(modeSelectorSource, />Documentation<\/span>/);
});

test('l’accueil présente les menus puis le graphe puis le simplifié', () => {
  const simple = modeSelectorSource.indexOf("name: 'Éditeur simplifié'");
  const menus = modeSelectorSource.indexOf("name: 'Éditeur par menus'");
  const graph = modeSelectorSource.indexOf("name: 'Éditeur graphe'");
  assert.ok(menus >= 0 && graph > menus && simple > graph);
  assert.doesNotMatch(modeSelectorSource, /name: 'Éditeur libre'/);
  assert.match(modeSelectorSource, /onClick:\s*onSelectGraph/);
  assert.match(
    appShellSource,
    /onStartAdvancedProject=\{workspace\.onStartAdvancedProject\}/,
  );
});
