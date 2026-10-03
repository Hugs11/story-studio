// Transformations de chemins autorisées sur les références médias d'un projet.
//
// Deux directions, et rien d'autre : relativiser vers le dossier du `.mbah` à
// l'écriture, résoudre un `./...` contre un dossier projet à la lecture. Un
// chemin hors du dossier reste absolu et intact. Aucune autre valeur n'est
// touchée : `assetRef`, payload d'auteur, identité, état de vue, arbre Libre et
// oracle `nativeGraph` traversent ces fonctions sans changer d'un octet.
//
// Ces fonctions sont pures : `projectIO.js` les utilise pour ses écritures, la
// résolution disque compatible workspace restant asynchrone de son côté.

import { toProjectRelativePath } from '../utils/fileUtils.js';
import { walkProjectMediaReferences } from './projectModel/index.js';

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Absolu → `./...` si le fichier est sous `directory`, sinon inchangé.
export function toProjectRelativeMediaPath(path, directory) {
  if (!hasPath(path)) return path;
  return toProjectRelativePath(path, directory);
}

// `./...` → absolu contre `directory`. Un chemin déjà absolu, une URL ou un
// chemin vide sont rendus tels quels : déplacer le dossier ne les concerne pas.
export function fromProjectRelativeMediaPath(path, directory) {
  if (!hasPath(path)) return path;
  if (!path.startsWith('./') && !path.startsWith('../')) return path;
  const baseDir = String(directory ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  return `${baseDir}/${path.replace(/^\.\//, '')}`;
}

// Applique `transform` à chaque référence média rendue par le walker, sur un
// clone. Une liaison avancée est atteinte par sa seule clé `path`.
export function mapProjectMediaPaths(project, transform) {
  const cloned = structuredClone(project);
  for (const ref of walkProjectMediaReferences(cloned)) {
    ref.obj[ref.key] = transform(ref.path);
  }
  return cloned;
}

export function relativizeProjectMediaPaths(project, directory) {
  return mapProjectMediaPaths(project, (path) => toProjectRelativeMediaPath(path, directory));
}

export function resolveProjectMediaPaths(project, directory) {
  return mapProjectMediaPaths(project, (path) => fromProjectRelativeMediaPath(path, directory));
}
