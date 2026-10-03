// Inventaire des jeux d'icônes du dépôt.
//
// La preuve est une liste, pas une lecture : ce script balaie les sources de
// l'interface et rend **tout fichier qui dessine des icônes**, avec le nombre de
// dessins qu'il porte. Un seul jeu doit rester pour l'application ; les
// familles qui subsistent sont nommées ici avec leur raison.
//
// Est comptée pour un dessin toute forme SVG déclarée en dur — `path`, `circle`,
// `rect`, `polygon`, `polyline`, `line` — écrite en JSX ou en tableau de nœuds.
// Un `<svg>` dont le contenu est calculé (les arêtes d'un diagramme, une courbe
// de forme d'onde) n'est pas un dessin d'icône et n'entre pas dans le compte.
//
// Utilisation :
//   node scripts/audit-icon-sets.mjs          # la liste, lisible
//   node scripts/audit-icon-sets.mjs --json   # la même, pour un test

import process from 'node:process';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx']);

// Le jeu partagé — le seul vocabulaire de l'application.
export const SHARED_ICON_SET = 'src/components/icons/LucideLocal.jsx';

// Les familles qui ne sont pas le vocabulaire de l'application, et pourquoi.
// Chacune est nommée : une exception tue est une exception oubliée.
const ALLOWED_FAMILIES = Object.freeze([
  {
    file: 'src/components/layout/TitleBar.jsx',
    reason:
      "Boutons de fenêtre. Ils sont dessinés sur la grille de 16 des chromes système, "
      + "qu'ils imitent volontairement, et ne nomment aucune notion du produit.",
  },
  {
    file: 'src/components/icons/LuniiIcon.jsx',
    reason: "Marque déposée, pas une icône : un logo ne se remplace pas par un dessin du jeu.",
  },
  {
    file: 'src/components/layout/ValidationPill.jsx',
    reason:
      "Un caret plein de 9 px, glyphe typographique. Le chevron tracé du jeu partagé rendrait "
      + "un trait d'un demi-pixel à cette taille.",
  },
  {
    file: 'src/components/CommunityPackChecker/communityPackExports.js',
    reason:
      "Rapport HTML autonome, produit hors React et hors CSS de l'application. Raccorder ses dix "
      + "dessins à la table changerait l'allure d'un livrable exporté : chantier distinct et "
      + "borné, laissé hors du périmètre de l'unification des jeux d'icônes.",
  },
  {
    file: 'src/components/AdvancedGraphCanvas/engines/cytoscapeEngine.js',
    reason:
      "Décorations SVG du canvas Cytoscape (prises et glyphe d'aiguillage), composées dans la "
      + "texture des nœuds pour survivre au dézoom ; elles ne constituent pas un vocabulaire DOM.",
  },
]);

const SHAPE_TAGS = ['path', 'circle', 'rect', 'polygon', 'polyline', 'line'];
// JSX et balisage en chaîne : <path d="…" />, <circle cx="…" />…
// La géométrie doit être **écrite en dur**. `[^>{]*?` écarte donc `d={edge.d}` :
// un tracé calculé — une arête de diagramme, une forme d'onde — n'est pas une
// icône, et le compter ferait passer une mise en page pour un jeu de dessins.
const JSX_SHAPE = new RegExp(`<(${SHAPE_TAGS.join('|')})\\s[^>{]*?/>`, 'g');
// Tableau de nœuds : ['path', { d: '…' }]
const NODE_SHAPE = new RegExp(`\\[\\s*'(${SHAPE_TAGS.join('|')})'\\s*,`, 'g');

async function listSourceFiles(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...await listSourceFiles(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(item.name))) found.push(full);
  }
  return found.sort();
}

function countShapes(source) {
  let count = 0;
  for (const pattern of [JSX_SHAPE, NODE_SHAPE]) {
    pattern.lastIndex = 0;
    count += [...source.matchAll(pattern)].length;
  }
  return count;
}

/** Les fichiers qui dessinent des icônes, du plus fourni au moins fourni. */
export async function collectIconSets() {
  const files = await listSourceFiles(SOURCE_DIR);
  const sets = [];
  for (const file of files) {
    const shapes = countShapes(await readFile(file, 'utf8'));
    if (shapes === 0) continue;
    sets.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), shapes });
  }
  return sets.sort((a, b) => b.shapes - a.shapes || a.file.localeCompare(b.file));
}

/** Les jeux qui ne sont ni le jeu partagé ni une famille nommée. */
export function unexplainedSets(sets) {
  const allowed = new Set(ALLOWED_FAMILIES.map((family) => family.file));
  return sets.filter((set) => set.file !== SHARED_ICON_SET && !allowed.has(set.file));
}

const shapeCount = (n) => `${n} forme${n > 1 ? 's' : ''}`;

function formatReport(sets) {
  const shared = sets.find((set) => set.file === SHARED_ICON_SET);
  const allowed = new Map(ALLOWED_FAMILIES.map((family) => [family.file, family.reason]));
  const lines = [
    `Jeu partagé : ${SHARED_ICON_SET} — ${shapeCount(shared?.shapes ?? 0)}`,
    '',
    'Familles conservées, et pourquoi :',
  ];
  for (const set of sets) {
    if (!allowed.has(set.file)) continue;
    lines.push(`  ${set.file} — ${shapeCount(set.shapes)}`);
    lines.push(`    ${allowed.get(set.file)}`);
  }
  const unexplained = unexplainedSets(sets);
  lines.push('');
  if (unexplained.length === 0) {
    lines.push('Aucun jeu d\'icônes en double.');
  } else {
    lines.push('Jeux non expliqués :');
    for (const set of unexplained) lines.push(`  ${set.file} — ${shapeCount(set.shapes)}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const sets = await collectIconSets();
  if (process.argv.includes('--json')) console.log(JSON.stringify(sets, null, 2));
  else console.log(formatReport(sets));
  process.exitCode = unexplainedSets(sets).length === 0 ? 0 : 1;
}
