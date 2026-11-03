import { card } from './catalogueFixtures.mjs';
export function syntheticCards(count) {
  return Array.from({ length: count }, (_, i) => card({ id: `synthetic-${i}`, title: `${i % 2 ? 'Les aventures extraordinaires de la famille des petits explorateurs' : 'Ours'} ${i}`,
    description: 'Un récit synthétique pour mesurer la consultation.', ageMin: i % 10, ageMax: i % 10 + 3,
    exemplars: Array.from({ length: 1 + i % 3 }, (_, j) => ({ id: `ex-${i}-${j}`, format: ['zip','project','folder','sevenZip'][(i+j)%4], sources: ['A','B'], available: i % 11 !== 0 })) }));
}
