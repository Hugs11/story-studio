// Adresse stable d'une jaquette de fiche, servie par le protocole
// `catalogue-cover` du moteur (src-tauri/src/commands/catalogue_cover_protocol.rs).
// L'empreinte de couverture (`coverSignature` de la liste) fait partie de
// l'adresse : une jaquette modifiée a une autre adresse, l'ancienne n'est
// jamais réutilisée et l'image peut rester en cache. `v1` est la version de
// l'encodeur (`cover_store::ENCODER`) : la changer change toutes les adresses.
//
// L'origine du protocole dépend de la WebView (`catalogue-cover://localhost`
// sous Linux et macOS, `http://catalogue-cover.localhost` sous Windows) :
// elle est demandée à Tauri (`convertFileSrc`) plutôt que devinée ici.
import { convertFileSrc } from '@tauri-apps/api/core';

export const COVER_SCHEME = 'catalogue-cover';
export const COVER_ENCODER = 'v1';

// Origine du protocole, sans barre finale ; `convert` est injectable en test.
export function coverOrigin(convert = convertFileSrc) {
  return convert('', COVER_SCHEME).replace(/\/+$/, '');
}

// `null` sans fiche ou sans empreinte : il n'y a alors aucune adresse à demander.
export function coverAddress(ficheId, signature, convert = convertFileSrc) {
  if (typeof ficheId !== 'string' || !ficheId || !/^[0-9a-f]{64}$/.test(signature ?? '')) return null;
  return `${coverOrigin(convert)}/${COVER_ENCODER}/${encodeURIComponent(ficheId)}/${signature}.jpg`;
}
