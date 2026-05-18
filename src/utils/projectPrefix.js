export function sanitizeProjectPrefix(name) {
  return String(name || '').trim()
    .replace(/[<>:"/\\|?*\[\]+]/g, '_')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
}
