// Les sources BASE des fixtures d'équivalence sont figées : elles importent
// encore des noms renommés depuis dans `src/`. Le harnais de test, seul, rend
// ces anciens noms à l'exécution des sources BASE ; `src/` n'en exporte aucun.
const ALIASES = {
  // `refTargetEntryId` est devenu `navigationTargetEntryId` avec le retrait de l'ancien nœud Lien.
  '/src/store/navigationTargets.js': 'export { navigationTargetEntryId as refTargetEntryId };',
};

export function withBaseSourceAliases(code, id) {
  const entry = Object.entries(ALIASES).find(([suffix]) => id.endsWith(suffix));
  return entry ? `${code}\n${entry[1]}\n` : code;
}
