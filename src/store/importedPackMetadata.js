import { sanitizeImportedName } from './importedNames.js';
import { basename } from '../utils/fileUtils.js';
import { parseConventionName, splitLeadingAge } from '../utils/packConvention.js';

// Appelée uniquement lorsqu'un pack devient un projet, jamais à la lecture
// d'un .mbah. La fiche apporte ses valeurs effectives ; aucun accès catalogue ici.
export function resolveImportedPackMetadata({ pack = {}, catalogue = null, fileName = '' } = {}) {
  const present = value => value != null && String(value).trim() !== '';
  const choose = (...values) => values.find(present) ?? '';
  const card = catalogue ?? {};
  const filename = basename(String(fileName).replace(/[/\\]+$/, '')).replace(/\.(zip|7z)$/i, '');
  const rawTitle = String(pack.title ?? '').trim();
  const titleConvention = parseConventionName(rawTitle);
  const fileConvention = parseConventionName(filename);
  const convention = titleConvention ?? fileConvention;
  const titleAge = splitLeadingAge(rawTitle);
  const fileAge = splitLeadingAge(filename);
  const packTitle = titleConvention ? titleConvention.title : titleAge ? titleAge.title : rawTitle;
  // La convention sans âge ni auteur n'est pas reconnue par le parseur.
  // Ne retirer que le suffixe qui correspond à la version portée par le pack.
  const stripPackVersion = (value) => String(value).replace(/(?:_V| V)(\d+)$/, (suffix, number) => (
    Number(number) === Number(pack.version) ? '' : suffix
  ));
  const title = titleConvention?.title || sanitizeImportedName(stripPackVersion(packTitle), '')
    || String(card.title ?? '').trim() || fileConvention?.title || sanitizeImportedName(stripPackVersion(fileAge?.title ?? filename), '');
  const version = Number(pack.version ?? convention?.version);
  return {
    title,
    minAge: String(choose(pack.minAge, titleConvention?.minAge, titleAge?.minAge, card.minAge, fileConvention?.minAge, fileAge?.minAge)),
    author: String(choose(pack.author, titleConvention?.author, card.author, convention?.author)),
    description: String(choose(pack.description, card.description)),
    version: Number.isInteger(version) && version > 0 ? version : 1,
    ...(present(choose(pack.maxAge, titleConvention?.maxAge, convention?.maxAge))
      ? { maxAge: choose(pack.maxAge, titleConvention?.maxAge, convention?.maxAge) } : {}),
    producer: convention?.producer ?? '',
    bonus: convention?.bonus ?? '',
    namingMode: 'convention',
    legacyExportName: '',
    legacyName: '',
  };
}
