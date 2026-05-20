export function sanitizeProjectPrefix(name) {
  return String(name || '').trim()
    .replace(/[<>:"/\\|?*\[\]+]/g, '_')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
}

function stem(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.[^/.]+$/, '') || '';
}

export function getProjectFilePrefix(project, savePath = null) {
  return sanitizeProjectPrefix(project?.projectName || stem(savePath) || 'nouveau-projet');
}
