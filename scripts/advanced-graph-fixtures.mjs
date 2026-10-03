// Fixtures synthétiques et reproductibles du banc d'essai.
//
// Elles sont **synthétiques** : aucun média privé, aucun extrait du corpus
// privé n'entre dans le dépôt public. Les profils privés réellement essayés
// sont identifiés dans les preuves privées, pas ici.
//
// Les chiffres retenus sont des **profils d'essai, pas des plafonds
// produit**, et leurs unités ne se mélangent pas : médiane 123,5 nœuds, p90
// 795, maximum 9 121 nœuds, maximum 2 078 Actions sur un **autre** profil,
// maximum 21 176 arêtes. Aucun de ces maxima n'est additionné à un autre, et
// 101 options n'est pas qualifié d'invalide.
//
// Tout est déterministe : un générateur pseudo-aléatoire à graine fixe, aucun
// appel à `Math.random`, aucune date. Deux exécutions produisent les mêmes
// octets, ce que « recette reproductible » exige.

import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUTPUT_DIR = nodePath.resolve(
  fileURLToPath(new URL('../src-tauri/tests/fixtures/graph-view', import.meta.url)),
);

// Générateur congruentiel linéaire : court, déterministe, sans dépendance.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function uuidLike(index) {
  const hex = index.toString(16).padStart(12, '0');
  return `0f9c2a41-1d3e-4a8b-9c77-${hex}`;
}

// Un document du dialecte STUdio v1, écrit dans la forme exacte que le codec
// attend. Les champs présence-sensibles sont émis ou omis délibérément : une
// fixture qui renseignerait les cinq contrôles partout ne ferait jamais passer
// la lecture des contrôles incomplets.
function buildDocument({
  stageCount,
  actionCount,
  optionsPerAction,
  seed,
  sharedActionRatio = 0.25,
  cycleRatio = 0.1,
  repeatedOptionRatio = 0.15,
  withPositions = false,
  projectedOffset = null,
}) {
  const random = seeded(seed);
  const stages = [];
  const actions = [];

  for (let index = 0; index < actionCount; index += 1) {
    const options = [];
    const width = typeof optionsPerAction === 'function'
      ? optionsPerAction(index, random)
      : optionsPerAction;
    for (let ordinal = 0; ordinal < width; ordinal += 1) {
      // Des options répétées vers la même cible : c'est précisément ce
      // qu'aucun moteur n'a le droit de dédupliquer.
      const repeated = ordinal > 0 && random() < repeatedOptionRatio;
      const target = repeated
        ? options[ordinal - 1]
        : uuidLike(Math.floor(random() * stageCount));
      options.push(target);
    }
    const action = { id: `action-${index}`, options };
    if (random() < 0.5) action.name = `Action ${index}`;
    if (random() < 0.2) action.type = 'story.storyaction';
    actions.push(action);
  }

  for (let index = 0; index < stageCount; index += 1) {
    const stage = { uuid: uuidLike(index) };
    if (index === 0) stage.squareOne = true;
    if (random() < 0.85) stage.name = `Écran ${index}`;
    if (random() < 0.3) stage.type = 'story';
    if (random() < 0.6) stage.audio = `audio-${index % 64}.mp3`;
    if (random() < 0.5) stage.image = `image-${index % 32}.png`;
    // Un objet de contrôles parfois complet, parfois partiel, parfois absent.
    const controlDraw = random();
    if (controlDraw < 0.5) {
      stage.controlSettings = {
        wheel: random() < 0.5,
        ok: true,
        home: random() < 0.5,
        pause: false,
        autoplay: random() < 0.3,
      };
    } else if (controlDraw < 0.75) {
      stage.controlSettings = { ok: true, home: null };
    }
    if (actionCount > 0) {
      // Une part des Écrans vise la **même** Action : le partage doit être
      // visible comme convergence d'arêtes.
      const shared = random() < sharedActionRatio;
      const actionIndex = shared
        ? index % Math.max(1, Math.floor(actionCount / 8))
        : Math.floor(random() * actionCount);
      const width = actions[actionIndex].options.length;
      stage.okTransition = {
        actionNode: `action-${actionIndex}`,
        // `-1` est le port « option aléatoire » du dialecte, pas une valeur
        // corrompue : la fixture doit en porter.
        optionIndex: random() < 0.15 ? -1 : Math.floor(random() * Math.max(1, width)),
      };
      if (random() < cycleRatio) {
        stage.homeTransition = {
          actionNode: `action-${actionIndex}`,
          optionIndex: 0,
        };
      }
    }
    if (withPositions) {
      stage.position = {
        x: Math.round((random() - 0.5) * 4_000),
        y: Math.round((random() - 0.5) * 2_000),
      };
    }
    stages.push(stage);
  }

  const document = {
    title: 'Fixture de charge',
    version: 1,
    format: 'v1',
    actionNodes: actions,
    stageNodes: stages,
  };

  const context = {
    documentOrigin: projectedOffset === null ? 'imported-studio' : 'imported-fs',
    defaultValueOrigin: projectedOffset === null ? 'source-studio' : 'source-native-derived',
    packIdentity: {
      origin: 'square-one-stage',
      value: uuidLike(0),
      shortIdentity: null,
      sourcePath: `/stageNodes/@uuid=${uuidLike(0)}#0`,
      unresolvedReason: null,
    },
  };

  // Le quadrillage de la projection FS : `x = (i + 1) * 160`, qui atteint
  // `x = 376 960` sur 2 356 Écrans. Il est servi au rang 2 de la disposition et
  // n'est ni remplacé ni corrigé par le placement de secours.
  if (projectedOffset !== null) {
    context.editorPositions = stages.map((stage, index) => ({
      path: `/stageNodes/@uuid=${stage.uuid}#0/position`,
      origin: 'projection-derived',
      position: { x: (index + 1) * 160, y: 160 },
    }));
  }

  return { payloadVersion: 1, document, context };
}

// Ajuste le profil dense pour qu'il porte **exactement** le nombre d'arêtes
// annoncé. Les options sont ajoutées ou retirées en fin de liste, sur les
// dernières Actions : le chiffre publié est alors celui qui a été mesuré, et
// non un « environ » qui obligerait le rapport à arrondir.
function tuneEdgeCount(payload, targetEdges) {
  const actions = payload.document.actionNodes;
  const firstStage = payload.document.stageNodes[0].uuid;
  let edges = countEdges(payload);
  let cursor = actions.length - 1;
  while (edges > targetEdges && cursor >= 0) {
    // Jamais en dessous d'une option : une sélection aléatoire exige N >= 1,
    // et une Action vide changerait ce que le profil mesure.
    if (actions[cursor].options.length > 1) {
      actions[cursor].options.pop();
      edges -= 1;
    } else {
      cursor -= 1;
    }
  }
  while (edges < targetEdges) {
    actions[actions.length - 1].options.push(firstStage);
    edges += 1;
  }
  return payload;
}

function countEdges(payload) {
  const { document } = payload;
  let edges = 0;
  for (const stage of document.stageNodes) {
    if (stage.okTransition) edges += 1;
    if (stage.homeTransition) edges += 1;
  }
  for (const action of document.actionNodes) edges += action.options.length;
  return edges;
}

// Les profils du protocole de charge. Chacun nomme **ce qu'il mesure** ; aucun
// n'est un plafond, et aucun ne mélange les unités d'un autre.
export const PROFILES = [
  {
    name: 'mediane-124',
    why: 'Médiane mesurée de 123,5 nœuds, arrondie au nœud entier.',
    build: () => buildDocument({ stageCount: 100, actionCount: 24, optionsPerAction: 3, seed: 1 }),
  },
  {
    name: 'p90-795',
    why: 'p90 mesuré de 795 nœuds.',
    build: () => buildDocument({ stageCount: 640, actionCount: 155, optionsPerAction: 4, seed: 2 }),
  },
  {
    name: 'max-9121',
    why: 'Maximum mesuré de 9 121 nœuds : le profil du criblage éliminatoire.',
    build: () => buildDocument({ stageCount: 7_300, actionCount: 1_821, optionsPerAction: 3, seed: 3 }),
  },
  {
    name: 'actions-2078',
    why: "Maximum mesuré de 2 078 Actions, sur un profil distinct : ce chiffre ne s'additionne à aucun autre.",
    build: () => buildDocument({ stageCount: 900, actionCount: 2_078, optionsPerAction: 2, seed: 4 }),
  },
  {
    name: 'dense-21176',
    why: 'Maximum mesuré de 21 176 arêtes : le second profil du criblage éliminatoire.',
    build: () => buildDocument({
      stageCount: 1_500,
      actionCount: 1_400,
      // Des Actions larges, pour atteindre la densité d'arêtes sans gonfler le
      // nombre de nœuds : c'est bien la densité qui est mesurée ici.
      optionsPerAction: (index) => (index % 7 === 0 ? 26 : 13),
      seed: 5,
      repeatedOptionRatio: 0.3,
    }),
    tune: (payload) => tuneEdgeCount(payload, 21_176),
  },
  {
    name: 'roues-100-101',
    why: "Roues de 100 et 101 options. 101 est UNTESTED, jamais INVALID.",
    build: () => buildDocument({
      stageCount: 220,
      actionCount: 40,
      optionsPerAction: (index) => {
        if (index === 0) return 100;
        if (index === 1) return 101;
        // Les roues réelles vont jusqu'à 40 ; les fixtures montent à 100.
        return index < 8 ? 40 : 5;
      },
      seed: 6,
    }),
  },
  {
    name: 'projete-376960',
    why: "Quadrillage de projection FS atteignant x = 376 960 sur 2 356 Écrans.",
    build: () => buildDocument({
      stageCount: 2_356,
      actionCount: 400,
      optionsPerAction: 3,
      seed: 7,
      projectedOffset: 0,
    }),
  },
  {
    name: 'degrade-gvi',
    why: "Document décodable mais invalide au sens GVI : il doit être **lu**, pas refusé.",
    build: () => {
      const payload = buildDocument({ stageCount: 60, actionCount: 20, optionsPerAction: 3, seed: 8 });
      // Identifiant dupliqué, cible pendante, option nulle, sélection hors
      // bornes, second squareOne : cinq refus GVI, tous lisibles.
      payload.document.stageNodes.push({ ...payload.document.stageNodes[5] });
      payload.document.stageNodes[7].squareOne = true;
      payload.document.actionNodes[0].options = ['stage-fantome', null, uuidLike(1)];
      payload.document.stageNodes[3].okTransition = { actionNode: 'action-0', optionIndex: 99 };
      payload.document.stageNodes[4].okTransition = { actionNode: 'action-absente', optionIndex: 0 };
      return payload;
    },
  },
];

export function describeProfile(profile) {
  const payload = profile.tune ? profile.tune(profile.build()) : profile.build();
  return {
    name: profile.name,
    why: profile.why,
    stages: payload.document.stageNodes.length,
    actions: payload.document.actionNodes.length,
    nodes: payload.document.stageNodes.length + payload.document.actionNodes.length,
    options: payload.document.actionNodes.reduce((total, action) => total + action.options.length, 0),
    edges: countEdges(payload),
    payload,
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = [];
  for (const profile of PROFILES) {
    const described = describeProfile(profile);
    const file = `${described.name}.payload.json`;
    // `JSON.stringify` sans indentation : c'est la chaîne de payload telle que
    // Story Studio la transporte, pas un document relu pour l'œil.
    await fs.writeFile(nodePath.join(OUTPUT_DIR, file), JSON.stringify(described.payload));
    const { payload, ...summary } = described;
    manifest.push({ ...summary, file, bytes: JSON.stringify(payload).length });
    process.stdout.write(
      `${described.name.padEnd(20)} ${String(described.nodes).padStart(6)} nœuds  `
      + `${String(described.stages).padStart(6)} Écrans  ${String(described.actions).padStart(6)} Actions  `
      + `${String(described.options).padStart(6)} options  ${String(described.edges).padStart(6)} arêtes\n`,
    );
  }
  await fs.writeFile(
    nodePath.join(OUTPUT_DIR, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`\n${manifest.length} profils écrits dans ${OUTPUT_DIR}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
