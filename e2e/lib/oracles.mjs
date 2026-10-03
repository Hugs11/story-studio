// Oracles indépendants de toute spécification : ils affirment des faits que
// l'on peut vérifier sans savoir ce que l'interface « devrait » montrer.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { studioVerdict } from '../studio/studio.mjs';

const invoke = (page, cmd, args) => page.evaluate(
  ([name, payload]) => window.__TAURI_INTERNALS__.invoke(name, payload),
  [cmd, args],
);

// Exporté pour les parcours qui ont besoin d'appeler directement une commande
// Tauri (ex. `load_pack_zip` sur une archive quelconque, sans passer par le
// funnel d'import), en plus des oracles ci-dessous qui l'utilisent déjà.
export const invokeTauri = invoke;

/**
 * Lit le `story.json` brut d'une archive (originale ou produite) via la même
 * commande que la relecture (`load_pack_zip`), pour comparer des champs
 * (ex. `nightModeAvailable`, `uuid`) entre deux packs sans réimplémenter de
 * lecteur ZIP. Renvoie `{ storyJson, error }` : `storyJson` est `null` en cas
 * d'échec (pack refusé), `error` porte alors le message.
 */
export async function readStoryJson(page, zipPath) {
  try {
    const raw = await invoke(page, 'load_pack_zip', { zipPath });
    return { storyJson: JSON.parse(raw), error: null };
  } catch (error) {
    return { storyJson: null, error: String(error?.message ?? error) };
  }
}

/**
 * Relecture d'une archive produite, par Story Studio (validateur Lunii et
 * lecteur de pack de l'app) puis par STUdio. `ok` n'est vrai que si les trois
 * l'acceptent et s'accordent sur le nombre d'écrans.
 */
export async function readbackPack(page, zipPath, studioOutDir) {
  const validation = await invoke(page, 'validate_lunii_zip_cmd', { zipPath });
  let pack = null;
  let loadError = null;
  try {
    pack = JSON.parse(await invoke(page, 'load_pack_zip', { zipPath }));
  } catch (error) {
    loadError = String(error?.message ?? error);
  }
  const studio = studioVerdict(zipPath, studioOutDir);
  const stageCount = Array.isArray(pack?.stageNodes) ? pack.stageNodes.length : null;
  return {
    ok: validation.valid && !loadError && studio.ok
      && (stageCount === null || stageCount === studio.stageNodes),
    validation: { valid: validation.valid, issues: validation.issues },
    storyStudio: loadError ? { error: loadError } : { stageNodes: stageCount, uuid: pack?.uuid ?? null, version: pack?.version ?? null },
    studio,
  };
}

// Entrées d'une archive `{ nom: { crc, size } }`, lues dans le répertoire
// central du zip. L'horodatage des entrées est ignoré : deux générations du
// même projet peuvent différer par l'heure d'écriture sans différer par leur
// contenu.
export function zipEntries(zipPath) {
  const bytes = readFileSync(zipPath);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error(`Répertoire central introuvable : ${zipPath}`);
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const entries = {};
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error(`Entrée centrale invalide : ${zipPath}`);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    entries[name] = { crc, size };
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Même contenu : mêmes noms d'entrées, mêmes CRC, mêmes tailles.
export function samePackContent(zipA, zipB) {
  const a = zipEntries(zipA);
  const b = zipEntries(zipB);
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const differences = names.filter(name => !a[name] || !b[name] || a[name].crc !== b[name].crc || a[name].size !== b[name].size);
  return { same: differences.length === 0, differences };
}

// Inventaire récursif `{ chemin relatif: taille }`, pour affirmer ce qu'une
// opération a écrit ou laissé derrière elle (`.partial`, copies orphelines…).
export function inventory(dir) {
  const files = {};
  const walk = current => {
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(dir, path)] = statSync(path).size;
    }
  };
  walk(dir);
  return files;
}

export function inventoryDiff(before, after) {
  return {
    added: Object.keys(after).filter(key => !(key in before)),
    removed: Object.keys(before).filter(key => !(key in after)),
    changed: Object.keys(after).filter(key => key in before && before[key] !== after[key]),
  };
}
