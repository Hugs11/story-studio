import { KEYS, read, write, remove } from './persistentSettings.js';

// Liste des scopes connus + libellés pour l'UI.
// L'ordre détermine la priorité de dispatch et l'ordre d'affichage dans la modale.
export const SHORTCUT_SCOPES = [
  { id: 'general',     label: 'Général',                  description: 'Actifs partout dans l\'application.' },
  { id: 'tree',        label: 'Arbre du projet',          description: 'Actifs quand un élément de l\'arbre est sélectionné.' },
  { id: 'diagram',     label: 'Diagramme',                description: 'Actifs quand un nœud du diagramme est sélectionné.' },
  { id: 'mediaPanel',  label: 'Panneau Médias',           description: 'Actifs quand le panneau Médias est ouvert.' },
  { id: 'audioEditor', label: 'Éditeur audio',            description: 'Actifs uniquement dans la fenêtre d\'édition audio.' },
  { id: 'imageEditor', label: 'Éditeur d\'image',         description: 'Actifs uniquement dans la fenêtre d\'édition d\'image.' },
  { id: 'a11y',        label: 'Navigation standard',      description: 'Raccourcis ARIA universels. Non modifiables pour préserver l\'accessibilité.' },
];

// Définition d'un raccourci.
// - id : identifiant interne, sert de clé de stockage
// - label : nom affiché dans la modale
// - scope : un des SHORTCUT_SCOPES
// - readOnly : si true, listé dans la modale mais non capturable (a11y, etc.)
// - defaultShortcut : combinaison par défaut
// - aliases : combinaisons équivalentes acceptées en plus du raccourci principal
// - description : sous-titre court (optionnel)
export const SHORTCUT_DEFINITIONS = [
  // ── Général ────────────────────────────────────────────────────────────────
  { id: 'newProject',       scope: 'general', label: 'Retour à l’accueil',                  defaultShortcut: { ctrl: true, key: 'n', code: 'KeyN' } },
  { id: 'openProject',      scope: 'general', label: 'Ouvrir un projet',                   defaultShortcut: { ctrl: true, key: 'o', code: 'KeyO' } },
  { id: 'saveProject',      scope: 'general', label: 'Enregistrer le projet',              defaultShortcut: { ctrl: true, key: 's', code: 'KeyS' } },
  { id: 'saveAs',           scope: 'general', label: 'Enregistrer sous',                    defaultShortcut: { ctrl: true, shift: true, key: 's', code: 'KeyS' } },
  { id: 'importStories',    scope: 'general', label: 'Importer des histoires',              defaultShortcut: { ctrl: true, key: 'i', code: 'KeyI' } },
  { id: 'addFolder',        scope: 'general', label: 'Ajouter un dossier',                  defaultShortcut: { ctrl: true, shift: true, key: 'n', code: 'KeyN' } },
  {
    id: 'storySettings', scope: 'general', label: 'Options du pack',
    defaultShortcut: { ctrl: true, key: ',', code: 'Comma' },
    aliases: [
      { ctrl: true, key: 'm', code: 'KeyM' },
      { ctrl: true, key: '.', code: 'Period' },
      { ctrl: true, key: ';', code: 'Semicolon' },
    ],
  },
  { id: 'toggleTree',       scope: 'general', label: 'Afficher/masquer l\'arbre',           defaultShortcut: { ctrl: true, key: '1', code: 'Digit1' }, aliases: [{ ctrl: true, key: '1', code: 'Numpad1' }] },
  { id: 'toggleSettings',   scope: 'general', label: 'Afficher/masquer les réglages',       defaultShortcut: { ctrl: true, key: '2', code: 'Digit2' }, aliases: [{ ctrl: true, key: '2', code: 'Numpad2' }] },
  { id: 'toggleDiagram',    scope: 'general', label: 'Afficher/masquer le diagramme',       defaultShortcut: { ctrl: true, key: '3', code: 'Digit3' }, aliases: [{ ctrl: true, key: '3', code: 'Numpad3' }] },
  { id: 'tabOptions',       scope: 'general', label: 'Préférences',                         defaultShortcut: { ctrl: true, shift: true, key: 'o', code: 'KeyO' } },
  { id: 'generate',         scope: 'general', label: 'Générer le pack',                    defaultShortcut: { ctrl: true, key: 'g', code: 'KeyG' } },
  { id: 'treeSearch',       scope: 'general', label: 'Rechercher dans la structure',        defaultShortcut: { ctrl: true, key: 'f', code: 'KeyF' } },
  { id: 'toggleValidation', scope: 'general', label: 'Ouvrir les éléments à corriger',      defaultShortcut: { ctrl: true, shift: true, key: 'e', code: 'KeyE' } },
  { id: 'undo',             scope: 'general', label: 'Annuler',                             defaultShortcut: { ctrl: true, key: 'z', code: 'KeyZ' } },
  { id: 'redo',             scope: 'general', label: 'Rétablir',                            defaultShortcut: { ctrl: true, shift: true, key: 'z', code: 'KeyZ' } },

  // ── Arbre du projet ───────────────────────────────────────────────────────
  { id: 'treeCopy',   scope: 'tree', label: 'Copier la sélection',            defaultShortcut: { ctrl: true, key: 'c', code: 'KeyC' } },
  { id: 'treeCut',    scope: 'tree', label: 'Couper la sélection',            defaultShortcut: { ctrl: true, key: 'x', code: 'KeyX' } },
  { id: 'treePaste',  scope: 'tree', label: 'Coller',                         defaultShortcut: { ctrl: true, key: 'v', code: 'KeyV' } },
  { id: 'treeDelete', scope: 'tree', label: 'Supprimer la sélection',         defaultShortcut: { key: 'Delete', code: 'Delete' }, aliases: [{ key: 'Backspace', code: 'Backspace' }] },

  // ── Diagramme ─────────────────────────────────────────────────────────────
  { id: 'diagramCopy',   scope: 'diagram', label: 'Copier la sélection',       defaultShortcut: { ctrl: true, key: 'c', code: 'KeyC' } },
  { id: 'diagramCut',    scope: 'diagram', label: 'Couper la sélection',       defaultShortcut: { ctrl: true, key: 'x', code: 'KeyX' } },
  { id: 'diagramPaste',  scope: 'diagram', label: 'Coller',                    defaultShortcut: { ctrl: true, key: 'v', code: 'KeyV' } },
  { id: 'diagramDelete', scope: 'diagram', label: 'Supprimer la sélection',    defaultShortcut: { key: 'Delete', code: 'Delete' }, aliases: [{ key: 'Backspace', code: 'Backspace' }] },

  // ── Panneau Médias ────────────────────────────────────────────────────────
  { id: 'mediaSearch', scope: 'mediaPanel', label: 'Rechercher dans les médias', defaultShortcut: { ctrl: true, shift: true, key: 'f', code: 'KeyF' } },

  // ── Éditeur audio ─────────────────────────────────────────────────────────
  { id: 'audioPlayPause',     scope: 'audioEditor', label: 'Lecture / Pause',                 defaultShortcut: { key: ' ', code: 'Space' } },
  { id: 'audioShuttleBack',   scope: 'audioEditor', label: 'Lecture arrière (jog/shuttle)',   defaultShortcut: { key: 'j', code: 'KeyJ' } },
  { id: 'audioShuttleStop',   scope: 'audioEditor', label: 'Pause (jog/shuttle)',             defaultShortcut: { key: 'k', code: 'KeyK' } },
  { id: 'audioShuttleFwd',    scope: 'audioEditor', label: 'Lecture avant (jog/shuttle)',     defaultShortcut: { key: 'l', code: 'KeyL' } },
  { id: 'audioNudgeBack',     scope: 'audioEditor', label: 'Reculer de 50 ms (avec preview)', defaultShortcut: { key: 'ArrowLeft', code: 'ArrowLeft' } },
  { id: 'audioNudgeFwd',      scope: 'audioEditor', label: 'Avancer de 50 ms (avec preview)', defaultShortcut: { key: 'ArrowRight', code: 'ArrowRight' } },
  { id: 'audioGoStart',       scope: 'audioEditor', label: 'Aller au début',                  defaultShortcut: { key: 'Home', code: 'Home' } },
  { id: 'audioGoEnd',         scope: 'audioEditor', label: 'Aller à la fin',                  defaultShortcut: { key: 'End', code: 'End' } },
  { id: 'audioMarkIn',        scope: 'audioEditor', label: 'Marquer le point d\'entrée',      defaultShortcut: { key: 'i', code: 'KeyI' } },
  { id: 'audioMarkOut',       scope: 'audioEditor', label: 'Marquer le point de sortie',      defaultShortcut: { key: 'o', code: 'KeyO' } },
  { id: 'audioClearIn',       scope: 'audioEditor', label: 'Effacer le point d\'entrée',      defaultShortcut: { ctrl: true, key: 'i', code: 'KeyI' } },
  { id: 'audioClearOut',      scope: 'audioEditor', label: 'Effacer le point de sortie',      defaultShortcut: { ctrl: true, key: 'o', code: 'KeyO' } },
  { id: 'audioPreviewIn',     scope: 'audioEditor', label: 'Aller au point d\'entrée',        defaultShortcut: { shift: true, key: 'i', code: 'KeyI' } },
  { id: 'audioPreviewOut',    scope: 'audioEditor', label: 'Aller au point de sortie',        defaultShortcut: { shift: true, key: 'o', code: 'KeyO' } },
  { id: 'audioKeepSelection', scope: 'audioEditor', label: 'Garder la sélection',             defaultShortcut: { ctrl: true, key: 'k', code: 'KeyK' } },
  { id: 'audioCutSelection',  scope: 'audioEditor', label: 'Supprimer la sélection',          defaultShortcut: { ctrl: true, key: 'x', code: 'KeyX' } },
  { id: 'audioUndo',          scope: 'audioEditor', label: 'Annuler la modification',          defaultShortcut: { ctrl: true, key: 'z', code: 'KeyZ' } },
  { id: 'audioZoomIn',        scope: 'audioEditor', label: 'Zoomer autour du curseur',         defaultShortcut: { ctrl: true, key: '+', code: 'Equal' }, aliases: [{ ctrl: true, key: '=', code: 'Equal' }, { ctrl: true, key: '+', code: 'NumpadAdd' }] },
  { id: 'audioZoomOut',       scope: 'audioEditor', label: 'Dézoomer autour du curseur',       defaultShortcut: { ctrl: true, key: '-', code: 'Minus' }, aliases: [{ ctrl: true, key: '-', code: 'NumpadSubtract' }] },
  { id: 'audioClose',         scope: 'audioEditor', label: 'Fermer l\'éditeur audio',          defaultShortcut: { key: 'Escape', code: 'Escape' }, readOnly: true, readOnlyReason: 'Convention universelle pour fermer une modale.' },

  // ── Éditeur d'image ───────────────────────────────────────────────────────
  { id: 'imageClose', scope: 'imageEditor', label: 'Fermer l\'éditeur d\'image', defaultShortcut: { key: 'Escape', code: 'Escape' }, readOnly: true, readOnlyReason: 'Convention universelle pour fermer une modale.' },

  // ── Navigation standard (a11y, lecture seule) ─────────────────────────────
  { id: 'a11yNextItem',     scope: 'a11y', label: 'Élément suivant (arbre, listbox, menu)',    defaultShortcut: { key: 'ArrowDown', code: 'ArrowDown' }, readOnly: true, readOnlyReason: 'Standard ARIA — non modifiable.' },
  { id: 'a11yPrevItem',     scope: 'a11y', label: 'Élément précédent (arbre, listbox, menu)',  defaultShortcut: { key: 'ArrowUp', code: 'ArrowUp' }, readOnly: true, readOnlyReason: 'Standard ARIA — non modifiable.' },
  { id: 'a11yFirstItem',    scope: 'a11y', label: 'Premier élément (listbox)',                  defaultShortcut: { key: 'Home', code: 'Home' }, readOnly: true, readOnlyReason: 'Standard ARIA — non modifiable.' },
  { id: 'a11yLastItem',     scope: 'a11y', label: 'Dernier élément (listbox)',                  defaultShortcut: { key: 'End', code: 'End' }, readOnly: true, readOnlyReason: 'Standard ARIA — non modifiable.' },
  { id: 'a11yActivate',     scope: 'a11y', label: 'Activer / valider (bouton, option)',         defaultShortcut: { key: 'Enter', code: 'Enter' }, aliases: [{ key: ' ', code: 'Space' }], readOnly: true, readOnlyReason: 'Standard ARIA — non modifiable.' },
  { id: 'a11yClose',        scope: 'a11y', label: 'Fermer un menu / popover / dialogue',        defaultShortcut: { key: 'Escape', code: 'Escape' }, readOnly: true, readOnlyReason: 'Convention universelle.' },
  { id: 'a11yMultiSelect',  scope: 'a11y', label: 'Étendre la sélection (arbre, diagramme)',    defaultShortcut: { shift: true, key: 'ArrowDown', code: 'ArrowDown' }, readOnly: true, readOnlyReason: 'Standard ARIA — non modifiable.' },
  { id: 'a11yToggleSelect', scope: 'a11y', label: 'Ajouter à la sélection (arbre, diagramme)',  defaultShortcut: { ctrl: true, key: 'Click', code: 'Click' }, readOnly: true, readOnlyReason: 'Convention système — non modifiable.' },
];

const EDITABLE_DEFINITIONS = SHORTCUT_DEFINITIONS.filter((d) => !d.readOnly);

export const DEFAULT_SHORTCUTS = Object.fromEntries(
  EDITABLE_DEFINITIONS.map((definition) => [definition.id, normalizeShortcut(definition.defaultShortcut)]),
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

function normalizeStoredShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object' || Array.isArray(shortcut)) return null;
  const normalized = normalizeShortcut(shortcut);
  return normalized.code || normalized.key ? normalized : null;
}

function keyLabelFromCode(code, key) {
  if (code?.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code?.startsWith('Digit')) return code.slice(5);
  if (code?.startsWith('Numpad')) return code.slice(6).replace(/^([a-z])/, (m) => m.toUpperCase());
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
  if (code === 'NumpadAdd') return '+';
  if (code === 'NumpadSubtract') return '-';
  if (code === 'Enter') return 'Entrée';
  if (code === 'Space') return 'Espace';
  if (code === 'Escape') return 'Échap';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'Home') return 'Home';
  if (code === 'End') return 'End';
  if (code === 'PageUp') return 'Page↑';
  if (code === 'PageDown') return 'Page↓';
  if (code === 'Tab') return 'Tab';
  if (code === 'Delete') return 'Suppr';
  if (code === 'Backspace') return '⌫';
  if (code === 'Click') return 'Clic';
  if (code && code.startsWith('F') && /^F\d+$/.test(code)) return code;
  if (key) return key.length === 1 ? key.toUpperCase() : key;
  return code || '';
}

export function formatShortcut(shortcut) {
  if (!shortcut) return '';
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
  const parsed = read(KEYS.KEYBOARD_SHORTCUTS, { parse: JSON.parse });
  if (!parsed) return DEFAULT_SHORTCUTS;
  const { shortcuts: migrated, changed } = migratePanelToggleShortcuts(parsed);
  if (changed) saveKeyboardShortcuts(migrated);
  return Object.fromEntries(
    EDITABLE_DEFINITIONS.map((definition) => [
      definition.id,
      normalizeStoredShortcut(migrated?.[definition.id])
        ?? normalizeShortcut(definition.defaultShortcut),
    ]),
  );
}

// Vague 2 : le modèle « onglets » (tabEdit/tabDiagram + tabOptions sur Ctrl+3)
// devient les 3 bascules de panneaux (toggleTree/toggleSettings/toggleDiagram sur
// Ctrl+1/2/3) et tabOptions déménage sur Ctrl+Maj+O. Migre le blob persisté pour
// éviter des ids morts et un conflit Ctrl+3 invisible entre tabOptions et toggleDiagram.
//
// Correspondance sémantique des vraies personnalisations : tabEdit devient
// toggleSettings (surface la plus proche de l'ancien espace d'édition) et
// tabDiagram devient toggleDiagram. Une nouvelle clé valide gagne toujours ;
// une valeur legacy qui était un ancien défaut laisse les nouveaux Ctrl+1/2/3.
function migratePanelToggleShortcuts(shortcuts) {
  const isShortcutRecord = !!shortcuts && typeof shortcuts === 'object' && !Array.isArray(shortcuts);
  const next = isShortcutRecord ? { ...shortcuts } : {};
  let changed = !isShortcutRecord;
  const legacyValues = {
    tabEdit: normalizeStoredShortcut(next.tabEdit),
    tabDiagram: normalizeStoredShortcut(next.tabDiagram),
  };

  // 1. tabOptions déménage vers Ctrl+Maj+O UNIQUEMENT si sa valeur stockée est un
  //    ancien défaut connu (Ctrl+3 ou Ctrl+4 legacy avant la migration
  //    simulateur). Une vraie personnalisation utilisateur est conservée.
  const legacyOptionsDefaults = [
    { ctrl: true, key: '3', code: 'Digit3' },
    { ctrl: true, key: '4', code: 'Digit4' },
  ];
  if ('tabOptions' in next) {
    const storedOptions = normalizeStoredShortcut(next.tabOptions);
    if (!storedOptions
      || legacyOptionsDefaults.some((legacy) => shortcutEquals(storedOptions, legacy))) {
      next.tabOptions = normalizeShortcut({ ctrl: true, shift: true, key: 'o', code: 'KeyO' });
      changed = true;
    }
  }

  // 2. toggleTree n'a pas d'équivalent legacy. Les alias Numpad restent gérés
  //    par findShortcutAction tant que la combinaison est le défaut.
  if (!normalizeStoredShortcut(next.toggleTree)) {
    next.toggleTree = normalizeShortcut(
      SHORTCUT_DEFINITIONS.find((definition) => definition.id === 'toggleTree').defaultShortcut,
    );
    changed = true;
  }

  // 3. Capture effectuée, les ids legacy peuvent maintenant être supprimés.
  for (const legacyId of ['tabEdit', 'tabDiagram']) {
    if (legacyId in next) {
      delete next[legacyId];
      changed = true;
    }
  }

  const mappings = [
    {
      legacyId: 'tabEdit',
      targetId: 'toggleSettings',
      legacyDefaults: [{ ctrl: true, key: '1', code: 'Digit1' }],
    },
    {
      legacyId: 'tabDiagram',
      targetId: 'toggleDiagram',
      legacyDefaults: [
        { ctrl: true, key: '2', code: 'Digit2' },
        { ctrl: true, key: '3', code: 'Digit3' },
      ],
    },
  ];
  for (const { legacyId, targetId, legacyDefaults } of mappings) {
    // Une nouvelle clé valide, même personnalisée, est la source de vérité.
    if (normalizeStoredShortcut(next[targetId])) continue;
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === targetId);
    const fallback = normalizeShortcut(definition.defaultShortcut);
    const legacy = legacyValues[legacyId];
    const isLegacyCustomization = !!legacy
      && !legacyDefaults.some((oldDefault) => shortcutEquals(legacy, oldDefault));
    // Ne pas introduire une collision silencieuse : la personnalisation legacy
    // n'est copiée que si aucune autre action générale effective ne l'utilise.
    next[targetId] = isLegacyCustomization
      && !hasGeneralShortcutConflict(next, targetId, legacy)
      ? legacy
      : fallback;
    changed = true;
  }

  return { shortcuts: next, changed };
}

function hasGeneralShortcutConflict(shortcuts, actionId, shortcut) {
  return EDITABLE_DEFINITIONS.some((definition) => {
    if (definition.scope !== 'general' || definition.id === actionId) return false;
    const effective = normalizeStoredShortcut(shortcuts?.[definition.id])
      ?? normalizeShortcut(definition.defaultShortcut);
    if (shortcutEquals(effective, shortcut)) return true;
    return shortcutEquals(effective, definition.defaultShortcut)
      && (definition.aliases ?? []).some((alias) => shortcutEquals(alias, shortcut));
  });
}

export function saveKeyboardShortcuts(shortcuts) {
  write(KEYS.KEYBOARD_SHORTCUTS, shortcuts, { serialize: JSON.stringify });
}

export function resetKeyboardShortcuts() {
  remove(KEYS.KEYBOARD_SHORTCUTS);
  return DEFAULT_SHORTCUTS;
}

export function resetKeyboardShortcutsForScope(shortcuts, scope) {
  const next = { ...shortcuts };
  for (const definition of EDITABLE_DEFINITIONS) {
    if (definition.scope === scope) {
      next[definition.id] = normalizeShortcut(definition.defaultShortcut);
    }
  }
  return next;
}

// Capture une combinaison de touches depuis un évènement clavier.
// Refuse les events de touches "modifier-only" (Ctrl seul, Shift seul, etc.).
// N'exige PAS de modifier — Espace, J, Escape, etc. sont des raccourcis valides.
export function shortcutFromEvent(event) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Unidentified'].includes(event.key)) return null;
  if (!event.code && !event.key) return null;
  return normalizeShortcut({
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
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

// Conflits limités au même scope : Ctrl+X peut exister en 'tree' ET en 'audioEditor'.
export function findShortcutConflict(shortcuts, actionId, shortcut) {
  const target = SHORTCUT_DEFINITIONS.find((d) => d.id === actionId);
  if (!target) return null;
  return EDITABLE_DEFINITIONS.find((definition) => (
    definition.id !== actionId
    && definition.scope === target.scope
    && shortcutEquals(shortcuts?.[definition.id] ?? definition.defaultShortcut, shortcut)
  )) || null;
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

// Snapshot global des raccourcis courants — App.jsx le pousse à chaque update.
// Permet aux composants enfants de lire les raccourcis sans prop-drilling.
let CURRENT_SHORTCUTS = DEFAULT_SHORTCUTS;

export function setCurrentShortcuts(shortcuts) {
  CURRENT_SHORTCUTS = shortcuts || DEFAULT_SHORTCUTS;
}

export function getCurrentShortcuts() {
  return CURRENT_SHORTCUTS;
}

// Recherche une action correspondant à l'évènement.
// Si `scope` est fourni, ne considère que les raccourcis de ce scope.
// Sinon, parcourt tous les scopes (utile pour le dispatcher global).
export function findShortcutAction(event, shortcuts, scope = null) {
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.readOnly) continue;
    if (scope && definition.scope !== scope) continue;
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
