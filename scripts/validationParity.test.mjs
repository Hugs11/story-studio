// Test de parite JS<->Rust pour la validation projet.
// Charge les fixtures partagees scripts/fixtures/validation-projects.json
// et verifie que le moteur JS produit le meme verdict (ok/fail) que celui
// documente. Le pendant Rust est dans src-tauri/src/domain/tests/parity.rs.
//
// Quand on ajoute une regle de validation : ajouter ici un cas (avec verdict
// et mots-cles attendus), implementer la regle des DEUX cotes, et faire
// passer ce test ET le test Rust. Si une regle existe d'un seul cote, c'est
// une divergence : la documenter explicitement dans projectValidation.js
// section "regles UX uniquement".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProjectData } from '../src/store/projectModel.js';
import { getGenerateErrors } from '../src/store/projectValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(__dirname, 'fixtures', 'validation-projects.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

function buildFileAudit(trueList = []) {
  const audit = {};
  for (const p of trueList) audit[p] = true;
  return audit;
}

for (const fixture of fixtures.cases) {
  test(`parity[${fixture.name}] - ${fixture.expect}`, () => {
    const project = normalizeProjectData(fixture.project);
    const fileAudit = buildFileAudit(fixture.fileAuditTrue ?? []);
    const errors = getGenerateErrors(project, fileAudit);
    if (fixture.expect === 'ok') {
      assert.deepEqual(
        errors,
        [],
        `JS doit accepter "${fixture.name}", erreurs recues: ${JSON.stringify(errors, null, 2)}`,
      );
    } else if (fixture.expect === 'fail') {
      assert.ok(
        errors.length > 0,
        `JS doit refuser "${fixture.name}", aucune erreur produite`,
      );
      for (const keyword of fixture.jsKeywords ?? []) {
        assert.ok(
          errors.some((text) => text.toLowerCase().includes(keyword.toLowerCase())),
          `JS "${fixture.name}" doit produire une erreur contenant "${keyword}"; recu: ${JSON.stringify(errors)}`,
        );
      }
    } else {
      throw new Error(`expect "${fixture.expect}" inconnu pour ${fixture.name}`);
    }
  });
}
