// Registre du moteur livré. Les autres moteurs et leurs dépendances restent
// dans le banc d'essai, hors du graphe d'importation de l'application.

export const ENGINE_IDS = Object.freeze({
  CYTOSCAPE: 'cytoscape',
});

export const ENGINE_REGISTRY = Object.freeze({
  [ENGINE_IDS.CYTOSCAPE]: {
    id: ENGINE_IDS.CYTOSCAPE,
    label: 'Cytoscape.js',
    role: 'production',
    licence: 'MIT',
    async create(options) {
      const [{ createCytoscapeEngine }, cytoscape] = await Promise.all([
        import('./cytoscapeEngine.js'),
        import('cytoscape').then((module) => module.default ?? module),
      ]);
      return createCytoscapeEngine({ ...options, cytoscape });
    },
  },
});

export function engineDescriptor(id) {
  const descriptor = ENGINE_REGISTRY[id];
  if (!descriptor) throw new Error(`Moteur inconnu : ${id}`);
  return descriptor;
}
