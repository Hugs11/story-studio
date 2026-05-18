const STORAGE_KEY = 'storyStudioKeyboardShortcuts';

export const SHORTCUT_DEFINITIONS = [
  { id: 'newProject', label: 'Nouveau projet', defaultShortcut: { ctrl: true, shift: false, code: 'KeyN', key: 'n' } },
  { id: 'openProject', label: 'Ouvrir un projet', defaultShortcut: { ctrl: true, shift: false, code: 'KeyO', key: 'o' } },
  { id: 'saveProject', label: 'Sauvegarder le projet', defaultShortcut: { ctrl: true, shift: false, code: 'KeyS', key: 's' } },
  { id: 'saveAs', label: 'Enregistrer sous', defaultShortcut: { ctrl: true, shift: true, code: 'KeyS', key: 's' } },
  { id: 'importStories', label: 'Importer des histoires', defaultShortcut: { ctrl: true, shift: false, code: 'KeyI', key: 'i' } },
  { id: 'addFolder', label: 'Ajouter un dossier', defaultShortcut: { ctrl: true, shift: true, code: 'KeyN', key: 'n' } },
  {
    id: 'storySettings',
    label: "Réglages de l'histoire",
    defaultShortcut: { ctrl: true, shift: false, code: 'Comma', key: ',' },
    aliases: [
      { ctrl: true, shift: false, code: 'KeyM', key: 'm' },
      { ctrl: true, shift: false, code: 'Period', key: '.' },
      { ctrl: true, shift: false, code: 'Semicolon', key: ';' },
    ],
  },
  {
    id: 'tabEdit',
    label: 'Onglet édition',
    defaultShortcut: { ctrl: true, shift: false, code: 'Digit1', key: '1' },
    aliases: [{ ctrl: true, shift: false, code: 'Numpad1', key: '1' }],
  },
  {
    id: 'tabEmulator',
    label: 'Onglet émulateur',
    defaultShortcut: { ctrl: true, shift: false, code: 'Digit2', key: '2' },
    aliases: [{ ctrl: true, shift: false, code: 'Numpad2', key: '2' }],
  },
  {
    id: 'tabDiagram',
    label: 'Onglet diagramme',
    defaultShortcut: { ctrl: true, shift: false, code: 'Digit3', key: '3' },
    aliases: [{ ctrl: true, shift: false, code: 'Numpad3', key: '3' }],
  },
  {
    id: 'tabOptions',
    label: 'Onglet options',
    defaultShortcut: { ctrl: true, shift: false, code: 'Digit4', key: '4' },
    aliases: [{ ctrl: true, shift: false, code: 'Numpad4', key: '4' }],
  },
  { id: 'generate', label: 'Générer le pack', defaultShortcut: { ctrl: true, shift: true, code: 'Enter', key: 'enter' } },
  { id: 'treeSearch', label: 'Rechercher dans la structure', defaultShortcut: { ctrl: true, shift: false, code: 'KeyF', key: 'f' } },
];

export const DEFAULT_SHORTCUTS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, normalizeShortcut(definition.defaultShortcut)]),
);

export const DEFAULT_SHORTCUT_LABELS = getShortcutLabelMap(DEFAULT_SHORTCUTS);

function normalizeKey(key) {
  return String(key || '').toLowerCase();
}

function normalizeShortcut(shortcut) {
  return {
    ctrl: !!shortcut?.ctrl,
    shift: !!shortcut?.shift,
    alt: !!shortcut?.alt,
    meta: !!shortcut?.meta,
    code: shortcut?.code || '',
    key: normalizeKey(shortcut?.key),
  };
}

function keyLabelFromCode(code, key) {
  if (code?.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code?.startsWith('Digit')) return code.slice(5);
  if (code?.startsWith('Numpad')) return code.slice(6);
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Semicolon') return ';';
  if (code === 'Slash') return '/';
  if (code === 'Backslash') return '\\';
  if (code === 'Quote') return "'";
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'Enter') return 'Entrée';
  if (code === 'Space') return 'Espace';
  if (key) return key.length === 1 ? key.toUpperCase() : key;
  return code || '';
}

export function formatShortcut(shortcut) {
  const normalized = normalizeShortcut(shortcut);
  const parts = [];
  if (normalized.ctrl) parts.push('Ctrl');
  if (normalized.shift) parts.push('Shift');
  if (normalized.alt) parts.push('Alt');
  if (normalized.meta) parts.push('Meta');
  parts.push(keyLabelFromCode(normalized.code, normalized.key));
  return parts.filter(Boolean).join('+');
}

export function getShortcutLabelMap(shortcuts) {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((definition) => [
      definition.id,
      formatShortcut(shortcuts?.[definition.id] ?? definition.defaultShortcut),
    ]),
  );
}

export function loadKeyboardShortcuts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHORTCUTS;
    const parsed = JSON.parse(raw);
    return Object.fromEntries(
      SHORTCUT_DEFINITIONS.map((definition) => [
        definition.id,
        normalizeShortcut(parsed?.[definition.id] ?? definition.defaultShortcut),
      ]),
    );
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

export function saveKeyboardShortcuts(shortcuts) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {}
}

export function resetKeyboardShortcuts() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  return DEFAULT_SHORTCUTS;
}

export function shortcutFromEvent(event) {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  return normalizeShortcut({
    ctrl: true,
    shift: !!event.shiftKey,
    code: event.code,
    key: event.key,
  });
}

function shortcutEquals(left, right) {
  const a = normalizeShortcut(left);
  const b = normalizeShortcut(right);
  return a.ctrl === b.ctrl
    && a.shift === b.shift
    && a.alt === b.alt
    && a.meta === b.meta
    && (a.code ? a.code === b.code : a.key === b.key);
}

export function findShortcutConflict(shortcuts, actionId, shortcut) {
  return SHORTCUT_DEFINITIONS.find((definition) => (
    definition.id !== actionId && shortcutEquals(shortcuts?.[definition.id], shortcut)
  ));
}

function shortcutMatchesEvent(event, shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!!event.ctrlKey !== normalized.ctrl) return false;
  if (!!event.shiftKey !== normalized.shift) return false;
  if (!!event.altKey !== normalized.alt) return false;
  if (!!event.metaKey !== normalized.meta) return false;
  const eventKey = normalizeKey(event.key);
  return (normalized.code && event.code === normalized.code)
    || (!!normalized.key && eventKey === normalized.key);
}

export function findShortcutAction(event, shortcuts) {
  for (const definition of SHORTCUT_DEFINITIONS) {
    const shortcut = shortcuts?.[definition.id] ?? definition.defaultShortcut;
    if (shortcutMatchesEvent(event, shortcut)) return definition.id;
    if (shortcutEquals(shortcut, definition.defaultShortcut)) {
      for (const alias of definition.aliases ?? []) {
        if (shortcutMatchesEvent(event, alias)) return definition.id;
      }
    }
  }
  return null;
}
