export function toPackAssetName(assetName) {
  const trimmed = typeof assetName === 'string' ? assetName.trim() : '';
  if (!trimmed) return null;
  return trimmed.startsWith('assets/') ? trimmed : `assets/${trimmed}`;
}
