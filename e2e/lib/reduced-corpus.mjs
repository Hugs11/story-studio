// Corpus réduit configuré par reducedCorpusFile ou SS_E2E_REDUCED_CORPUS.
// Les fichiers restent dans corpus/ à côté du manifeste local, hors git.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.mjs';

let cached = null;

// Lit et met en cache le manifeste (format 2 : `entries`, verdict attendu par
// entrée). Lève une erreur explicite si le fichier est absent ou mal formé :
// mieux vaut un échec net qu'un parcours qui croit avoir un corpus réduit alors
// qu'il n'a rien trouvé.
export function loadReducedCorpus() {
  if (cached) return cached;
  const file = config.reducedCorpusFile;
  if (!file || !existsSync(file)) {
    throw new Error('Corpus réduit introuvable : renseigner SS_E2E_REDUCED_CORPUS, la clé '
      + '« reducedCorpusFile » de e2e/local.config.json (voir local.config.example.json).');
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.version !== 2 || !Array.isArray(data.entries)) {
    throw new Error(`Corpus réduit invalide (${file}) : format 2 attendu (champ « entries »).`);
  }
  cached = { ...data, file, corpusDir: join(dirname(file), 'corpus') };
  return cached;
}

// Les entrées du manifeste, chacune avec son chemin absolu (`absPath`).
export function reducedEntries() {
  const { entries, corpusDir } = loadReducedCorpus();
  return entries.map((entry) => ({ ...entry, absPath: join(corpusDir, entry.file) }));
}

// Correspondance des anciennes catégories de classement vers le verdict
// d'ouverture attendu, pour les parcours qui choisissent leurs packs par nature.
const OPEN_OF_CATEGORY = {
  '01 - Editable': (open) => open === 'menus+graphe',
  '02 - Lecture seule': (open) => open === 'graphe',
  '04 - Erreur import': (open) => String(open).startsWith('refus'),
};

// Chemins absolus des packs du corpus réduit dont l'ouverture attendue
// correspond à la catégorie `subDir` (ex. '01 - Editable'), dans l'ordre du
// manifeste.
export function reducedArchivesUnder(subDir) {
  const matches = OPEN_OF_CATEGORY[subDir];
  if (!matches) throw new Error(`Catégorie inconnue pour le corpus réduit : ${subDir}`);
  return reducedEntries()
    .filter((entry) => entry.kind === 'pack' && matches(entry.expect?.open))
    .map((entry) => entry.absPath);
}
