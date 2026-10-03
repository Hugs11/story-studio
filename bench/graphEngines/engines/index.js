// Registre réservé au banc : il étend le moteur livré sans faire entrer les
// candidats historiques dans le graphe d'importation de l'application.
import {
  ENGINE_IDS as APP_ENGINE_IDS,
  ENGINE_REGISTRY as APP_ENGINE_REGISTRY,
} from '../../../src/components/AdvancedGraphCanvas/engines/index.js';

export const ENGINE_IDS = Object.freeze({
  ...APP_ENGINE_IDS,
  G6: 'g6',
  VIS_NETWORK: 'vis-network',
});

export const FINALISTS = Object.freeze([ENGINE_IDS.CYTOSCAPE, ENGINE_IDS.G6]);

export const ENGINE_REGISTRY = Object.freeze({
  ...APP_ENGINE_REGISTRY,
  [ENGINE_IDS.G6]: {
    id: ENGINE_IDS.G6,
    label: 'AntV G6',
    role: 'finaliste',
    licence: 'MIT',
    async create(options) {
      const [{ createG6Engine }, g6] = await Promise.all([
        import('./g6Engine.js'),
        import('@antv/g6'),
      ]);
      return createG6Engine({ ...options, g6 });
    },
  },
  [ENGINE_IDS.VIS_NETWORK]: {
    id: ENGINE_IDS.VIS_NETWORK,
    label: 'vis-network',
    role: 'témoin',
    licence: 'Apache-2.0 OR MIT',
    async create(options) {
      const [{ createVisNetworkEngine }, visNetwork] = await Promise.all([
        import('./visNetworkEngine.js'),
        import('vis-network/standalone/esm/vis-network.js'),
      ]);
      return createVisNetworkEngine({ ...options, visNetwork });
    },
  },
});

export function engineDescriptor(id) {
  const descriptor = ENGINE_REGISTRY[id];
  if (!descriptor) throw new Error(`Moteur inconnu : ${id}`);
  return descriptor;
}

export const createBenchEngine = (id, options) => engineDescriptor(id).create(options);
