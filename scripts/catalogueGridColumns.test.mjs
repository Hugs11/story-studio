import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_COLUMNS, gridColumnCount } from '../src/store/catalogue/windowing.js';

// Volontaire : la règle d'origine (plancher 11rem, plafond fixe 6) est remplacée par
// colonnes = round(8 × largeur grille / largeur fenêtre), bornée par le plancher 11rem.
const rem = 16;
test('mesures réelles : 14" et 27", panneau fermé puis ouvert', () => {
  assert.equal(gridColumnCount({ width: 1796, windowWidth: 1846, rem }), 8);
  assert.equal(gridColumnCount({ width: 1298, windowWidth: 1846, rem }), 6);
  assert.equal(gridColumnCount({ width: 2530, windowWidth: 2554, rem }), 8);
  assert.equal(gridColumnCount({ width: 1990, windowWidth: 2554, rem }), 6);
});

test('fenêtre étroite : le résultat reste celui du plancher 11rem, à chaque frontière', () => {
  for (const r of [8, 13, 16, 20, 32]) {
    for (let width = 0; width <= 4096; width += 0.5) {
      const floor = Math.max(1, Math.floor((width + r) / (12 * r)));
      assert.equal(gridColumnCount({ width, windowWidth: width, rem: r }), Math.min(8, floor));
      // Fenêtre étroite (grille = fenêtre, moins de 8 vignettes de 11rem) : égal au plancher.
      if (floor < 8) assert.equal(gridColumnCount({ width, windowWidth: width, rem: r }), floor);
    }
  }
  assert.equal(gridColumnCount({ width: 700, windowWidth: 800, rem }), 3);
  assert.equal(gridColumnCount({ width: 100, windowWidth: 800, rem }), 1);
});

test('repli sans largeur de fenêtre : la grille est supposée occuper toute la fenêtre', () => {
  for (const width of [300, 1024, 1900, 4096]) {
    assert.equal(gridColumnCount({ width, rem }), gridColumnCount({ width, windowWidth: width, rem }));
    assert.equal(gridColumnCount({ width, windowWidth: 0, rem }), Math.min(8, Math.max(1, Math.floor((width + rem) / (12 * rem)))));
  }
});

test('constantes : plus de plafond fixe, gouttière autonome inchangée', () => {
  assert.equal(GRID_COLUMNS.cardsPerWindow, 8);
  assert.equal(GRID_COLUMNS.max, undefined);
  assert.equal(GRID_COLUMNS.standaloneGapPx, 16);
});
