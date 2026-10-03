// Hook de résolution ESM pour les tests Node : les modules de `src/` importent
// leurs voisins sans extension, ce que Vite résout et Node non. Le hook ajoute
// l'extension au lieu de modifier les imports de production ; aucun fichier
// source n'est réécrit ni transformé.
const SUFFIXES = ['.js', '/index.js', '.jsx'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error;
    for (const suffix of SUFFIXES) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context);
      } catch {
        // Suffixe suivant : seule l'erreur d'origine est remontée si aucun ne résout.
      }
    }
    throw error;
  }
}
