// Les capacités de projet.
//
// L'application posait une seule question — « ce projet a-t-il un arbre ? » —
// pour répondre à deux. Ces tests fixent l'écart entre les deux réponses, parce
// que c'est lui que les sites exploitent : un projet avancé est
// **ouvert** et n'a **pas d'arbre**. Tant que cet écart tient, un site peut
// choisir sa question sans qu'on relise l'écran.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasProjectTree,
  hierarchicalProjectType,
  isAdvancedProject,
  isProjectOpen,
} from '../src/store/projectWorkState.js';

const advancedProject = {
  schemaVersion: 4,
  authoringMode: 'advanced',
  projectType: 'advanced',
  projectName: 'pack repris',
  rootEntries: [],
  authoring: { payload: '{"payloadVersion":1}', editorState: { version: 1 }, mediaBindings: [] },
};

const packProject = { projectType: 'pack', rootEntries: [] };
const simpleProject = { projectType: 'simple', rootEntries: [] };
const noProject = { projectType: null, rootEntries: [] };

test('un projet avancé est ouvert et n\'a pas d\'arbre — c\'est tout l\'écart', () => {
  assert.equal(isProjectOpen(advancedProject), true);
  assert.equal(hasProjectTree(advancedProject), false);
  assert.equal(isAdvancedProject(advancedProject), true);
});

test('un projet Libre est ouvert et a un arbre, quelle que soit sa forme', () => {
  for (const project of [packProject, simpleProject]) {
    assert.equal(isProjectOpen(project), true);
    assert.equal(hasProjectTree(project), true);
    assert.equal(isAdvancedProject(project), false);
  }
});

test('sans projet, les deux capacités sont fausses ensemble', () => {
  for (const project of [noProject, undefined, null]) {
    assert.equal(isProjectOpen(project), false);
    assert.equal(hasProjectTree(project), false);
  }
});

// Le piège que les deux prédicats ferment : `projectType` vaut 'advanced' sur un
// projet avancé. Un site qui le lirait en direct croirait tenir un type
// hiérarchique. Les capacités passent par `hierarchicalProjectType`, qui rend
// `null`, et aucun appelant Libre ne voit jamais cette valeur.
test('la capacité d\'arbre ne lit jamais `projectType` en direct', () => {
  assert.equal(advancedProject.projectType, 'advanced');
  assert.equal(hierarchicalProjectType(advancedProject), null);
  assert.equal(hasProjectTree(advancedProject), false);
});

// Les prédicats ne changent aucune réponse : `hasProjectTree` rend exactement ce que les
// sites testaient avant lui, et `isProjectOpen` exactement ce que le couple
// « avancé, ou type choisi » disait déjà là où il était écrit à la main.
test('les deux prédicats reproduisent les tests qu\'ils remplacent', () => {
  for (const project of [advancedProject, packProject, simpleProject, noProject, undefined]) {
    assert.equal(hasProjectTree(project), hierarchicalProjectType(project) !== null);
    assert.equal(
      isProjectOpen(project),
      isAdvancedProject(project) || Boolean(project?.projectType),
    );
  }
});
