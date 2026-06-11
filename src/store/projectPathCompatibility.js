import { joinPath, pathKey } from '../utils/fileUtils.js';
import { MANAGED_PROJECT_DIRS } from './workspaceDirs.js';

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeRelativeProjectPath(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.startsWith('../')) normalized = normalized.slice(3);
  return normalized.replace(/^\/+/, '');
}

function managedDirMatches(segment) {
  return MANAGED_PROJECT_DIRS.some((dirName) => dirName.toLowerCase() === String(segment || '').toLowerCase());
}

export function workspaceFallbackForProjectRelativePath(relativePath, workspaceDir) {
  if (!hasPath(relativePath) || !hasPath(workspaceDir)) return null;
  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) return null;
  const normalized = normalizeRelativeProjectPath(relativePath);
  const firstSegment = normalized.split('/')[0];
  if (!managedDirMatches(firstSegment)) return null;
  return joinPath(workspaceDir, normalized);
}

export function chooseCompatibleProjectPath(relativePath, projectPath, workspaceDir, {
  projectExists = false,
  workspaceExists = false,
} = {}) {
  const workspacePath = workspaceFallbackForProjectRelativePath(relativePath, workspaceDir);
  if (!workspacePath || pathKey(workspacePath) === pathKey(projectPath)) return projectPath;
  return !projectExists && workspaceExists ? workspacePath : projectPath;
}
