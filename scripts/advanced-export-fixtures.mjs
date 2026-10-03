// Fixtures d'export : des **packs STUdio réels**, importables.
//
// Les fixtures de graphe produisent des payloads d'auteur ; un export, lui, a
// besoin de fichiers qui existent sur le disque. Ce générateur écrit donc de
// vraies archives `story.json` + `assets/`, avec des médias synthétisés octet
// par octet — un WAV PCM et un PNG RGB — pour que la préparation ait quelque
// chose à convertir et l'archive quelque chose à porter.
//
// Elles sont **synthétiques** et **déterministes** : aucun média privé, aucune
// date, aucun `Math.random`. Deux exécutions produisent les mêmes octets, sauf
// pour ce que le générateur est censé faire varier. Rien de tout cela n'a de
// dépendance npm : le ZIP est écrit en `store`, ce que le lecteur Rust accepte.
//
// ```bash
// node scripts/advanced-export-fixtures.mjs
// ```

import fs from 'node:fs/promises';
import nodePath from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUTPUT_DIR = nodePath.resolve(
  fileURLToPath(new URL('../src-tauri/tests/fixtures/advanced-export', import.meta.url)),
);

const SAMPLE_RATE = 44100;

// ── CRC-32, partagé par le ZIP et le PNG ─────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Médias synthétiques ──────────────────────────────────────────────────────

// Un WAV PCM 16 bits mono : un format que l'export doit convertir, ce qui rend
// la ligne `reencoded` du rapport visible au lieu d'un `verbatim` partout.
export function wavBytes({ seconds = 0.6, frequency = 440 } = {}) {
  const count = Math.floor(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const phase = (2 * Math.PI * frequency * index) / SAMPLE_RATE;
    data.writeInt16LE(Math.round(Math.sin(phase) * 0.6 * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// Un PNG RGB 8 bits, dégradé déterministe. Sa taille est volontairement
// différente de celle attendue par un pack : la préparation doit le
// redimensionner, ce qui rend la ligne `resized` observable.
export function pngBytes({ width = 320, height = 240, seed = 0 } = {}) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filtre « None »
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      const horizontal = Math.floor((x * 255) / Math.max(1, width));
      const vertical = Math.floor((y * 255) / Math.max(1, height));
      raw[offset] = seed % 3 === 0 ? horizontal : 20;
      raw[offset + 1] = seed % 3 === 1 ? vertical : 20;
      raw[offset + 2] = seed % 3 === 2 ? (horizontal + vertical) & 0xFF : 20;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // profondeur
  header[9] = 2;   // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Archive ZIP, écrite sans dépendance ──────────────────────────────────────

// Méthode `store` : le lecteur Rust l'accepte, et une fixture non compressée
// reste lisible à l'œil quand un cas tourne mal.
export function zipBytes(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);      // version minimale
    local.writeUInt16LE(0, 6);       // aucun drapeau
    local.writeUInt16LE(0, 8);       // store
    local.writeUInt16LE(0, 10);      // heure — figée, la fixture est déterministe
    local.writeUInt16LE(0x21, 12);   // date figée (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, bytes);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014B50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(0, 42); // décalage du local header, corrigé ci-dessous
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

// ── Documents ────────────────────────────────────────────────────────────────

const uuid = (index) => `0f9c2a41-1d3e-4a8b-9c77-${index.toString(16).padStart(12, '0')}`;
const controls = (overrides = {}) => ({
  wheel: false, ok: true, home: true, pause: false, autoplay: false, ...overrides,
});

// Le pack de référence du parcours : une entrée, un menu de trois options,
// trois histoires, et **une référence audio partagée par deux écrans** — le cas
// qu'il faut voir en entier lorsqu'un média manque.
//
// Sa navigation respecte les règles de STUdio (`native_pack/port_rules.rs`) :
// l'entrée n'a pas d'Accueil actif (sans destination, il la rechargerait), et
// l'Accueil d'une histoire, sans destination, ramène à l'entrée au lieu de
// retomber sur l'histoire elle-même par son propre choix du menu.
function mvpStory() {
  return {
    format: 'v1',
    version: 1,
    title: 'Parcours export G1',
    stageNodes: [
      {
        uuid: uuid(1),
        name: 'Couverture',
        squareOne: true,
        audio: 'intro.wav',
        image: 'cover.png',
        controlSettings: controls({ wheel: true, home: false }),
        okTransition: { actionNode: 'menu', optionIndex: 0 },
        homeTransition: null,
      },
      {
        uuid: uuid(2),
        name: 'Histoire du renard',
        audio: 'partagee.wav',
        image: 'vignette-a.png',
        controlSettings: controls(),
        okTransition: null,
        homeTransition: null,
      },
      {
        uuid: uuid(3),
        name: 'Histoire de la rivière',
        // La **même** référence que l'écran précédent : deux usages, une seule
        // liaison, une seule réparation.
        audio: 'partagee.wav',
        image: 'vignette-b.png',
        controlSettings: controls(),
        okTransition: null,
        homeTransition: null,
      },
      {
        uuid: uuid(4),
        name: 'Histoire sans image',
        audio: 'finale.wav',
        image: null,
        controlSettings: controls(),
        okTransition: null,
        homeTransition: null,
      },
    ],
    actionNodes: [
      { id: 'menu', name: 'Menu des histoires', options: [uuid(2), uuid(3), uuid(4)] },
    ],
  };
}

// Le pack qui **doit** bloquer l'export : un objet de contrôles incomplet, une
// Action orpheline porteuse de contenu, une extension inconnue transportée, et
// des positions que le format ne laisse pas passer sans décision — une fractionnaire
// et une hors de la plage courte du format cible.
function blockedStory() {
  return {
    format: 'v1',
    version: 1,
    title: 'Décisions requises',
    stageNodes: [
      {
        uuid: uuid(11),
        name: 'Entrée',
        squareOne: true,
        audio: 'intro.wav',
        image: 'cover.png',
        controlSettings: controls({ wheel: true }),
        okTransition: { actionNode: 'menu', optionIndex: 0 },
        homeTransition: null,
        // Fractionnaire : `POSITION_FRACTIONAL` seul n'impose pas d'arrondir.
        position: { x: 120.5, y: -40.25 },
      },
      {
        uuid: uuid(12),
        name: 'Écran aux contrôles incomplets',
        audio: 'finale.wav',
        image: null,
        // Un objet partiel n'est jamais complété d'office.
        controlSettings: { ok: true, home: true },
        okTransition: null,
        homeTransition: { actionNode: 'menu', optionIndex: 0 },
        // Extension inconnue : transportée, jamais interprétée.
        studioExtras: { mood: 'nocturne', tempo: 3 },
        // Hors de la plage courte du format cible : une décision explicite est
        // attendue, jamais un écrêtage silencieux.
        position: { x: 40000, y: 12 },
      },
    ],
    actionNodes: [
      { id: 'menu', name: 'Menu', options: [uuid(12)] },
      // Action orpheline **avec contenu** : conservée, diagnostiquée, et
      // l'auteur décide de son rattachement ou de son retrait.
      { id: 'orpheline', name: 'Chapitre abandonné', options: [uuid(12)] },
    ],
  };
}

const PROFILES = {
  'export-mvp': {
    story: mvpStory,
    assets: () => [
      ['intro.wav', wavBytes({ seconds: 0.5, frequency: 392 })],
      ['partagee.wav', wavBytes({ seconds: 0.7, frequency: 440 })],
      ['finale.wav', wavBytes({ seconds: 0.4, frequency: 523 })],
      ['cover.png', pngBytes({ width: 320, height: 240, seed: 0 })],
      ['vignette-a.png', pngBytes({ width: 320, height: 240, seed: 1 })],
      ['vignette-b.png', pngBytes({ width: 320, height: 240, seed: 2 })],
    ],
  },
  'export-blocked': {
    story: blockedStory,
    assets: () => [
      ['intro.wav', wavBytes({ seconds: 0.3, frequency: 349 })],
      ['finale.wav', wavBytes({ seconds: 0.3, frequency: 587 })],
      ['cover.png', pngBytes({ width: 320, height: 240, seed: 1 })],
    ],
  },
};

export function buildProfile(name) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`profil de fixture inconnu : ${name}`);
  const story = profile.story();
  const assets = profile.assets();
  return {
    name,
    story,
    assets,
    zip: zipBytes([
      ['story.json', JSON.stringify(story, null, 2)],
      ...assets.map(([assetName, bytes]) => [`assets/${assetName}`, bytes]),
    ]),
  };
}

export const PROFILE_NAMES = Object.keys(PROFILES);

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = [];
  for (const name of PROFILE_NAMES) {
    const profile = buildProfile(name);
    const file = nodePath.join(OUTPUT_DIR, `${name}.zip`);
    await fs.writeFile(file, profile.zip);
    manifest.push({
      name,
      zip: `${name}.zip`,
      bytes: profile.zip.length,
      stages: profile.story.stageNodes.length,
      actions: profile.story.actionNodes.length,
      assets: profile.assets.map(([assetName]) => assetName),
    });
    process.stdout.write(`${name}.zip — ${profile.zip.length} octets\n`);
  }
  await fs.writeFile(
    nodePath.join(OUTPUT_DIR, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
