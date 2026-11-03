import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test("le catalogue n'affiche pas d'anneau de focus coloré après un clic souris", () => {
  const screen = read('src/components/Catalogue/CatalogueScreen.css');
  assert.match(screen, /:root:not\(\[data-keyboard-navigation\]\)[^{]*:focus-visible \{\s*box-shadow: none !important;/);
  // La liste de l'app (common/Select.css) : anneau au clavier seulement, jamais après un clic souris.
  const select = read('src/components/common/Select.css');
  assert.match(select, /:root\[data-keyboard-navigation\] \.select-trigger:focus-visible \{/);
  assert.match(select, /\.select-trigger:focus \{ outline: none; \}/);
  assert.match(read('src/components/Catalogue/CatalogueToolbar.css'), /:root\[data-keyboard-navigation\] \.catalogue-sort:focus-within \{/);
  assert.match(read('src/components/Catalogue/lunii/LuniiStatusPill.css'), /:root\[data-keyboard-navigation\] \.lunii-status-pill:focus-visible/);
});
