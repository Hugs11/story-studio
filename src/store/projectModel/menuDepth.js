import projectLimits from '../../shared/projectLimits.json' with { type: 'json' };

const configuredMaxMenuDepth = Number(projectLimits?.maxMenuDepth);

if (!Number.isInteger(configuredMaxMenuDepth) || configuredMaxMenuDepth < 1) {
  throw new Error('La limite de profondeur des Dossiers est absente ou invalide.');
}

export const MAX_MENU_DEPTH = configuredMaxMenuDepth;
export const MENU_DEPTH_LIMIT_CODE = 'menu_depth_limit';

export const MENU_DEPTH_LIMIT_REACHED_MESSAGE =
  `Limite de ${MAX_MENU_DEPTH} Dossiers imbriqués atteinte.`;

export function formatProjectMenuDepthError(observedDepth) {
  return `Ce projet contient ${observedDepth} Dossiers imbriqués. Story Studio en prend en charge au maximum ${MAX_MENU_DEPTH}.`;
}

function entryChildren(entry) {
  if (Array.isArray(entry?.children)) return entry.children;
  if (Array.isArray(entry?.items)) return entry.items;
  return [];
}

function isMenuEntry(entry) {
  return entry?.type === 'menu'
    || Array.isArray(entry?.children)
    || (!entry?.type && Array.isArray(entry?.items));
}

function projectEntryRoots(project) {
  if (Array.isArray(project?.rootEntries)) return project.rootEntries;
  return [
    ...(Array.isArray(project?.rootItems) ? project.rootItems : []),
    ...(Array.isArray(project?.menus) ? project.menus : []),
  ];
}

function entryPathPart(entry) {
  return {
    id: typeof entry?.id === 'string' ? entry.id : null,
    name: typeof entry?.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : 'Dossier sans nom',
  };
}

function allowedDiagnostic(observedDepth = 0, path = []) {
  return {
    allowed: true,
    code: null,
    maxDepth: MAX_MENU_DEPTH,
    attemptedDepth: observedDepth,
    observedDepth,
    path,
  };
}

function rejectedDiagnostic(observedDepth, path) {
  return {
    allowed: false,
    code: MENU_DEPTH_LIMIT_CODE,
    maxDepth: MAX_MENU_DEPTH,
    attemptedDepth: observedDepth,
    observedDepth,
    path,
  };
}

/**
 * Mesure itérativement la profondeur authoring d'un projet. Le Menu racine vaut
 * zéro ; seuls les Dossiers rencontrés sur un même chemin sont comptés.
 */
export function getProjectMenuDepthDiagnostic(project) {
  const roots = [
    ...projectEntryRoots(project),
    ...(Array.isArray(project?.sharedEntries) ? project.sharedEntries : []),
  ];
  const stack = roots.map((entry) => ({ entry, parentDepth: 0, menuPath: [] })).reverse();
  let deepest = allowedDiagnostic();

  while (stack.length > 0) {
    const { entry, parentDepth, menuPath } = stack.pop();
    if (!entry || typeof entry !== 'object') continue;

    const menu = isMenuEntry(entry);
    const depth = parentDepth + (menu ? 1 : 0);
    const nextPath = menu ? [...menuPath, entryPathPart(entry)] : menuPath;
    if (depth > deepest.observedDepth) {
      deepest = depth > MAX_MENU_DEPTH
        ? rejectedDiagnostic(depth, nextPath)
        : allowedDiagnostic(depth, nextPath);
    }
    if (menu) {
      const children = entryChildren(entry);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ entry: children[index], parentDepth: depth, menuPath: nextPath });
      }
    }
  }

  return deepest;
}

export function getProjectMaxMenuDepth(project) {
  return getProjectMenuDepthDiagnostic(project).observedDepth;
}

/** Hauteur maximale en Dossiers d'un sous-arbre, feuille comprise à hauteur 0. */
export function getMenuSubtreeHeight(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const stack = [{ entry, parentHeight: 0 }];
  let maxHeight = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const menu = isMenuEntry(current.entry);
    const height = current.parentHeight + (menu ? 1 : 0);
    maxHeight = Math.max(maxHeight, height);
    if (!menu) continue;
    for (const child of entryChildren(current.entry)) {
      stack.push({ entry: child, parentHeight: height });
    }
  }
  return maxHeight;
}

export function getEntriesMenuHeight(entries) {
  return (entries ?? []).reduce(
    (height, entry) => Math.max(height, getMenuSubtreeHeight(entry)),
    0,
  );
}

export function getMenuDepth(project, menuId, projectIndex = null) {
  if (menuId == null || menuId === 'root') return 0;
  const indexedPath = projectIndex?.pathById?.get(menuId);
  if (indexedPath) return indexedPath.filter(isMenuEntry).length;

  const stack = projectEntryRoots(project)
    .map((entry) => ({ entry, parentDepth: 0 }))
    .reverse();
  while (stack.length > 0) {
    const { entry, parentDepth } = stack.pop();
    if (!entry || typeof entry !== 'object') continue;
    const menu = isMenuEntry(entry);
    const depth = parentDepth + (menu ? 1 : 0);
    if (entry.id === menuId) return menu ? depth : parentDepth;
    if (menu) {
      const children = entryChildren(entry);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ entry: children[index], parentDepth: depth });
      }
    }
  }
  return null;
}

function findDepthEntry(project, entryId) {
  const stack = projectEntryRoots(project).slice().reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || typeof entry !== 'object') continue;
    if (entry.id === entryId) return entry;
    if (!isMenuEntry(entry)) continue;
    const children = entryChildren(entry);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return null;
}

export function validateMenuDepthPlacement(project, targetMenuId, entries, projectIndex = null) {
  const parentDepth = getMenuDepth(project, targetMenuId, projectIndex);
  if (parentDepth == null) {
    return {
      allowed: false,
      code: 'menu_target_missing',
      maxDepth: MAX_MENU_DEPTH,
      attemptedDepth: null,
      observedDepth: getProjectMaxMenuDepth(project),
      path: [],
    };
  }
  const subtreeHeight = getEntriesMenuHeight(entries);
  return validateMenuHeightPlacement(project, targetMenuId, subtreeHeight, projectIndex);
}

export function validateMenuHeightPlacement(project, targetMenuId, subtreeHeight, projectIndex = null) {
  const parentDepth = getMenuDepth(project, targetMenuId, projectIndex);
  if (parentDepth == null) {
    return {
      allowed: false,
      code: 'menu_target_missing',
      maxDepth: MAX_MENU_DEPTH,
      attemptedDepth: null,
      observedDepth: getProjectMaxMenuDepth(project),
      path: [],
    };
  }
  const attemptedDepth = parentDepth + subtreeHeight;
  return attemptedDepth > MAX_MENU_DEPTH
    ? rejectedDiagnostic(attemptedDepth, [])
    : allowedDiagnostic(attemptedDepth, []);
}

export function validateMenuDepthMove(project, entryIds, targetMenuId, projectIndex = null) {
  const entries = (entryIds ?? [])
    .map((entryId) => projectIndex?.entryById?.get(entryId) ?? findDepthEntry(project, entryId))
    .filter(Boolean);
  return validateMenuDepthPlacement(project, targetMenuId, entries, projectIndex);
}

export class ProjectMenuDepthError extends Error {
  constructor(diagnostic) {
    super(formatProjectMenuDepthError(diagnostic.observedDepth));
    this.name = 'ProjectMenuDepthError';
    this.code = MENU_DEPTH_LIMIT_CODE;
    this.maxDepth = MAX_MENU_DEPTH;
    this.attemptedDepth = diagnostic.observedDepth;
    this.path = diagnostic.path;
  }
}

export function assertProjectMenuDepth(project) {
  const diagnostic = getProjectMenuDepthDiagnostic(project);
  if (!diagnostic.allowed) throw new ProjectMenuDepthError(diagnostic);
  return diagnostic;
}
