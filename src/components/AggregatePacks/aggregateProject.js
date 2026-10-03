// Le projet Libre que l'assistant « Assembler des packs » fait générer.
//
// Pur : aucun React, aucun Tauri. L'identité du pack est fournie par l'appelant,
// qui la tire une fois à l'ouverture de l'assistant ; ce module ne tire rien,
// sinon deux générations de suite livreraient deux packs distincts.

import { createZipEntry, DEFAULT_PACK_METADATA, normalizeProjectData } from '../../store/projectModel.js';
import { parseConventionName } from '../../utils/packConvention.js';

export function defaultMetadataForPacks(packs, uuid) {
  const parsed = packs
    .map((pack) => parseConventionName(pack.name || pack.fileName))
    .filter(Boolean);
  const ages = parsed
    .map((item) => Number.parseInt(item.minAge, 10))
    .filter((age) => Number.isFinite(age) && age > 0);
  return {
    ...DEFAULT_PACK_METADATA,
    title: 'Mes histoires du soir',
    minAge: ages.length ? String(Math.min(...ages)) : '3',
    version: 1,
    uuid,
  };
}

export function buildAggregateProject({ packs, rootAudio, rootImage, metadata }) {
  return normalizeProjectData({
    version: 1,
    projectName: metadata.title || 'Pack agrégé',
    rootName: metadata.title || 'Menu racine',
    packMetadata: metadata,
    projectType: 'pack',
    rootAudio,
    rootImage,
    thumbnailImage: rootImage,
    sameImage: true,
    // L'audio racine (menu agrégé) est le seul asset natif : il est harmonisé en
    // loudness et ses silences de bord normalisés. Les assets internes des ZIP
    // agrégés sont recopiés verbatim depuis l'archive et ne passent pas par la
    // pipeline audio — pas d'option exposée, ce traitement ne concerne que la racine.
    globalOptions: {
      silenceMode: 'normalize',
      harmonizeLoudness: true,
      autoNext: false,
      nightMode: false,
      aiImageGen: false,
    },
    rootEntries: packs.map((pack) => createZipEntry({
      name: pack.name,
      zipPath: pack.path,
      coverImage: pack.coverImage,
      coverAudio: pack.coverAudio,
    })),
  });
}
