// Le nom du fichier produit par l'éditeur graphe.
//
// Nommer l'archive d'après le seul titre du document donnerait `Le_Renard.zip`,
// quand la chaîne Libre écrit `[6+]Le_Renard[by_Esope_V2.zip`. L'écart avait
// une conséquence concrète : le moteur suffixe `-2`, `-3`… quand le nom est
// déjà pris, et ce suffixe dit « ce nom existait déjà », **pas** « deuxième
// version ». Deux productions successives du même pack produisaient donc des
// fichiers qu'un auteur pouvait prendre pour des révisions.
//
// **Où vivent ces valeurs, et pourquoi ce n'est pas une seconde vérité.**
// L'âge minimum, l'auteur, le producteur et le bonus ne composent que le **nom
// du fichier** : ils n'entrent dans aucun pack, ni côté Libre ni côté graphe —
// `story.json` porte le titre, la version, la description et l'identifiant, et
// rien d'autre. Ils vivent donc dans l'enveloppe du projet, exactement là où la
// chaîne Libre les garde déjà, et il n'existe aucune valeur du document qu'ils
// pourraient contredire. Le titre et la version, eux, **restent gouvernés par
// le document** : ils sont lus de lui, jamais recopiés dans l'enveloppe.
//
// **L'auteur choisit, et rien n'est choisi pour lui.** Deux modes, croisés avec
// la présence ou l'absence de version, donnent les quatre combinaisons qu'il
// doit pouvoir atteindre : nommer par convention ou librement, versionner ou
// non. Le **défaut est le nom libre**, qui retombe sur le titre : c'est
// ce que fait le moteur sans nom d'archive, et cela évite de poser
// sur son fichier un « 3+ » que personne n'a saisi.

import { generateConventionName } from '../../utils/packConvention.js';

export const ARCHIVE_NAMING_CONVENTION = 'convention';
export const ARCHIVE_NAMING_FREE = 'legacy';

// Les champs de l'enveloppe qui ne composent que le nom du fichier. Le titre et
// la version n'y sont pas : ils appartiennent au document.
const ARCHIVE_NAMING_FIELDS = Object.freeze([
  'namingMode', 'legacyExportName', 'minAge', 'author', 'producer', 'bonus',
]);

function text(value) {
  return String(value ?? '').trim();
}

/** Les seuls champs de nommage, extraits d'une fiche ou d'une enveloppe. */
export function archiveNamingFields(source = {}) {
  const fields = {};
  for (const field of ARCHIVE_NAMING_FIELDS) fields[field] = text(source?.[field]);
  fields.namingMode = fields.namingMode === ARCHIVE_NAMING_CONVENTION
    ? ARCHIVE_NAMING_CONVENTION
    : ARCHIVE_NAMING_FREE;
  return fields;
}

/**
 * Le nom de base de l'archive, sans extension et sans assainissement.
 *
 * L'assainissement reste au moteur — `sanitized_project_name` —, comme pour la
 * chaîne Libre : en tenir une seconde version ici la ferait diverger au premier
 * écart de règle.
 *
 * Rend `''` quand il n'y a ni nom libre ni titre. Le moteur retombe alors sur
 * son nom neutre.
 */
export function advancedArchiveBaseName({ packMetadata = null, title = '', version = null } = {}) {
  const naming = archiveNamingFields(packMetadata ?? {});
  const packTitle = text(title);

  if (naming.namingMode === ARCHIVE_NAMING_CONVENTION) {
    // La convention compose son nom avec la version **du document** : c'est
    // elle que la production écrira dans le pack, et le nom du fichier ne doit
    // pas en annoncer une autre.
    return generateConventionName({ ...naming, title: packTitle, version: version ?? 1 }) || packTitle;
  }

  return naming.legacyExportName || packTitle;
}

/**
 * Le titre que l'archive porte dans `story.json`.
 *
 * En convention, c'est le nom de convention lui-même — âge, auteur, version —,
 * exactement ce que la chaîne Libre écrit : la fiche garde le titre lisible,
 * l'archive porte le nom de classement. En nom libre, `''` : le moteur garde
 * alors le titre du document, comme avant.
 */
export function advancedStoryTitle({ packMetadata = null, title = '', version = null } = {}) {
  const naming = archiveNamingFields(packMetadata ?? {});
  if (naming.namingMode !== ARCHIVE_NAMING_CONVENTION) return '';
  return generateConventionName({ ...naming, title: text(title), version: version ?? 1 });
}
