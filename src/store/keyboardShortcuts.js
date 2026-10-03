import { KEYS, read, write, remove } from './persistentSettings.js';
import { commandKeyIsMeta, commandKeyLabel } from '../utils/platformKeys.js';

// Les portées, rangées par **commande** et non par surface.
//
// Une commande qui existe dans les deux éditeurs — enregistrer, annuler,
// copier la sélection — n'a qu'une définition : reconfigurée une fois, elle
// change partout. Les copies par surface (`treeCopy`, `diagramCopy`) se
// laissaient reconfigurer chacune de leur côté, et le même geste finissait par
// porter deux touches selon l'endroit où l'on cliquait.
//
// `contexts` dit **où** une portée est active. Deux raccourcis ne se
// contredisent que s'ils peuvent être actifs en même temps : Ctrl+X coupe de
// l'audio dans l'éditeur audio et des nœuds dans le graphe sans conflit, mais
// `M` ne peut pas servir à la fois une commande générale et la vue d'ensemble.
//
// L'ordre détermine la priorité de dispatch et l'ordre d'affichage dans la
// modale.
const SHORTCUT_CONTEXTS = Object.freeze({
  LIBRE: 'libre',
  GRAPH: 'graph',
  AUDIO_EDITOR: 'audioEditor',
  IMAGE_EDITOR: 'imageEditor',
});

const BOTH_EDITORS = Object.freeze([SHORTCUT_CONTEXTS.LIBRE, SHORTCUT_CONTEXTS.GRAPH]);

export const SHORTCUT_SCOPES = [
  { id: 'general',     label: 'Général',                  contexts: BOTH_EDITORS, description: 'Actifs dans les deux éditeurs, par menus et graphe.' },
  { id: 'selection',   label: 'Sélection',                contexts: BOTH_EDITORS, description: 'Agissent sur la sélection, dans l\'arbre, le diagramme ou le graphe.' },
  { id: 'libre',       label: 'Éditeur par menus',        contexts: [SHORTCUT_CONTEXTS.LIBRE], description: 'Actifs seulement dans l\'éditeur par menus.' },
  { id: 'graph',       label: 'Éditeur graphe',           contexts: [SHORTCUT_CONTEXTS.GRAPH], description: 'Actifs seulement dans l\'éditeur graphe.' },
  { id: 'mediaPanel',  label: 'Panneau Médias',           contexts: BOTH_EDITORS, description: 'Actifs quand le panneau Médias est ouvert.' },
  { id: 'audioEditor', label: 'Éditeur audio',            contexts: [SHORTCUT_CONTEXTS.AUDIO_EDITOR], description: 'Actifs uniquement dans la fenêtre d\'édition audio.' },
  { id: 'imageEditor', label: 'Éditeur d\'image',         contexts: [SHORTCUT_CONTEXTS.IMAGE_EDITOR], description: 'Actifs uniquement dans la fenêtre d\'édition d\'image.' },
  { id: 'a11y',        label: 'Navigation standard',      contexts: [], description: 'Raccourcis ARIA universels. Non modifiables pour préserver l\'accessibilité.' },
];

// Définition d'un raccourci.
// - id : identifiant interne, sert de clé de stockage
// - label : nom affiché dans la modale
// - scope : un des SHORTCUT_SCOPES
// - readOnly : si true, listé dans la modale mais non capturable (a11y, etc.)
// - defaultShortcut : combinaison par défaut
// - aliases : combinaisons équivalentes acceptées en plus du raccourci principal,
//   tant que le raccourci principal est celui par défaut
// - description : sous-titre court (optionnel)
export const SHORTCUT_DEFINITIONS = [
  // ── Général ────────────────────────────────────────────────────────────────
  { id: 'newProject',       scope: 'general', label: 'Retour à l’accueil',                  defaultShortcut: { ctrl: true, key: 'n', code: 'KeyN' } },
  { id: 'openProject',      scope: 'general', label: 'Ouvrir un projet',                   defaultShortcut: { ctrl: true, key: 'o', code: 'KeyO' } },
  { id: 'openPack',         scope: 'general', label: 'Ouvrir un pack',                     defaultShortcut: { ctrl: true, shift: true, key: 'p', code: 'KeyP' } },
  { id: 'saveProject',      scope: 'general', label: 'Enregistrer le projet',              defaultShortcut: { ctrl: true, key: 's', code: 'KeyS' } },
  { id: 'saveAs',           scope: 'general', label: 'Enregistrer sous',                    defaultShortcut: { ctrl: true, shift: true, key: 's', code: 'KeyS' } },
  {
    id: 'storySettings', scope: 'general', label: 'Options du pack',
    defaultShortcut: { ctrl: true, key: ',', code: 'Comma' },
    aliases: [
      { ctrl: true, key: 'm', code: 'KeyM' },
      { ctrl: true, key: '.', code: 'Period' },
      { ctrl: true, key: ';', code: 'Semicolon' },
    ],
  },
  { id: 'tabOptions',       scope: 'general', label: 'Préférences',                         defaultShortcut: { ctrl: true, shift: true, key: 'o', code: 'KeyO' } },
  { id: 'generate',         scope: 'general', label: 'Générer le pack',                    defaultShortcut: { ctrl: true, key: 'g', code: 'KeyG' } },
  { id: 'treeSearch',       scope: 'general', label: 'Rechercher dans la structure',        defaultShortcut: { ctrl: true, key: 'f', code: 'KeyF' } },
  { id: 'toggleValidation', scope: 'general', label: 'Ouvrir les éléments à corriger',      defaultShortcut: { ctrl: true, shift: true, key: 'e', code: 'KeyE' } },
  { id: 'undo',             scope: 'general', label: 'Annuler',                             defaultShortcut: { ctrl: true, key: 'z', code: 'KeyZ' } },
  { id: 'redo',             scope: 'general', label: 'Rétablir',                            defaultShortcut: { ctrl: true, shift: true, key: 'z', code: 'KeyZ' } },

  // ── Sélection (arbre, diagramme, graphe) ─────────────────────────────────
  { id: 'selectionCopy',      scope: 'selection', label: 'Copier la sélection',     defaultShortcut: { ctrl: true, key: 'c', code: 'KeyC' } },
  { id: 'selectionCut',       scope: 'selection', label: 'Couper la sélection',     defaultShortcut: { ctrl: true, key: 'x', code: 'KeyX' } },
  { id: 'selectionPaste',     scope: 'selection', label: 'Coller',                  defaultShortcut: { ctrl: true, key: 'v', code: 'KeyV' } },
  { id: 'selectionDuplicate', scope: 'selection', label: 'Dupliquer la sélection',  defaultShortcut: { ctrl: true, key: 'd', code: 'KeyD' } },
  { id: 'selectionDelete',    scope: 'selection', label: 'Supprimer la sélection',  defaultShortcut: { key: 'Delete', code: 'Delete' }, aliases: [{ key: 'Backspace', code: 'Backspace' }] },
  { id: 'selectionRename',    scope: 'selection', label: 'Renommer',                defaultShortcut: { key: 'F2', code: 'F2' } },

  // ── Éditeur par menus ─────────────────────────────────────────────────────
  { id: 'importStories',    scope: 'libre', label: 'Importer des histoires',              defaultShortcut: { ctrl: true, key: 'i', code: 'KeyI' } },
  { id: 'addFolder',        scope: 'libre', label: 'Ajouter un dossier',                  defaultShortcut: { ctrl: true, shift: true, key: 'n', code: 'KeyN' } },
  { id: 'toggleTree',       scope: 'libre', label: 'Afficher/masquer l\'arbre',           defaultShortcut: { ctrl: true, key: '1', code: 'Digit1' }, aliases: [{ ctrl: true, key: '1', code: 'Numpad1' }] },
  { id: 'toggleSettings',   scope: 'libre', label: 'Afficher/masquer les réglages',       defaultShortcut: { ctrl: true, key: '2', code: 'Digit2' }, aliases: [{ ctrl: true, key: '2', code: 'Numpad2' }] },
  { id: 'toggleDiagram',    scope: 'libre', label: 'Afficher/masquer le diagramme',       defaultShortcut: { ctrl: true, key: '3', code: 'Digit3' }, aliases: [{ ctrl: true, key: '3', code: 'Numpad3' }] },

  // ── Éditeur graphe ────────────────────────────────────────────────────────
  // `+` demande Maj sur un clavier AZERTY, pas sur un QWERTY où la touche porte
  // `=` : les variantes couvrent les deux, et le pavé numérique.
  {
    id: 'graphZoomIn', scope: 'graph', label: 'Agrandir',
    defaultShortcut: { key: '+', code: 'NumpadAdd' },
    aliases: [{ shift: true, key: '+', code: 'Equal' }, { key: '=', code: 'Equal' }],
  },
  {
    id: 'graphZoomOut', scope: 'graph', label: 'Réduire',
    defaultShortcut: { key: '-', code: 'NumpadSubtract' },
    aliases: [{ key: '-', code: 'Minus' }],
  },
  { id: 'graphFit',            scope: 'graph', label: 'Cadrer tout le graphe',     defaultShortcut: { key: '0', code: 'Digit0' }, aliases: [{ key: '0', code: 'Numpad0' }] },
  { id: 'graphVisitBack',      scope: 'graph', label: 'Nœud visité précédent',     defaultShortcut: { alt: true, key: 'ArrowLeft', code: 'ArrowLeft' } },
  { id: 'graphVisitForward',   scope: 'graph', label: 'Nœud visité suivant',       defaultShortcut: { alt: true, key: 'ArrowRight', code: 'ArrowRight' } },
  { id: 'graphCreateStage',    scope: 'graph', label: 'Créer un Écran sous le pointeur',   defaultShortcut: { key: 'e', code: 'KeyE' } },
  { id: 'graphCreateAction',   scope: 'graph', label: 'Créer une liste de choix sous le pointeur', defaultShortcut: { key: 'a', code: 'KeyA' } },
  { id: 'graphToggleOverview', scope: 'graph', label: 'Afficher/masquer la vue d’ensemble', defaultShortcut: { key: 'm', code: 'KeyM' } },
  { id: 'graphArrange',        scope: 'graph', label: 'Ranger le graphe',          defaultShortcut: { ctrl: true, shift: true, key: 'r', code: 'KeyR' } },
  // Geste de la surface, tenu par le moteur du graphe : listé pour être connu,
  // jamais capturé ni comparé aux autres commandes.
  {
    id: 'graphBoxSelect', scope: 'graph', label: 'Sélectionner une zone du graphe',
    defaultShortcut: { shift: true, key: 'Drag', code: 'Drag' },
    readOnly: true,
    readOnlyReason: 'Glisser sur le fond. Glisser ensuite un nœud sélectionné déplace toute la sélection.',
  },

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

// Le libellé d'une touche. Une lettre et un symbole s'affichent **tels qu'ils
// sont tapés** — sur un AZERTY, la touche de code `KeyQ` porte `A` —, un
// chiffre et une touche nommée par leur position.
function keyLabelFromCode(code, key) {
  if (/^[a-z]$/.test(key ?? '')) return key.toUpperCase();
  if (code?.startsWith('Digit')) return code.slice(5);
  if (code?.startsWith('Numpad')) return code.slice(6).replace(/^([a-z])/, (m) => m.toUpperCase())
    .replace(/^Add$/, '+').replace(/^Subtract$/, '-');
  if (typeof key === 'string' && key.length === 1 && key !== ' ') return key;
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
  if (code === 'Drag') return 'Glisser';
  if (code && code.startsWith('F') && /^F\d+$/.test(code)) return code;
  if (key) return key.length === 1 ? key.toUpperCase() : key;
  return code || '';
}

export function formatShortcut(shortcut) {
  if (!shortcut) return '';
  const normalized = normalizeShortcut(shortcut);
  const parts = [];
  if (normalized.ctrl) parts.push(commandKeyLabel());
  if (normalized.shift) parts.push('Shift');
  if (normalized.alt) parts.push('Alt');
  if (normalized.meta) parts.push('Meta');
  parts.push(keyLabelFromCode(normalized.code, normalized.key));
  return parts.filter(Boolean).join('+');
}

// Un texte suivi de son raccourci, pour une infobulle : « Agrandir (+) ».
export function withShortcut(text, shortcutLabel) {
  return shortcutLabel ? `${text} (${shortcutLabel})` : text;
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
  const panels = migratePanelToggleShortcuts(parsed);
  const selection = migrateSelectionShortcuts(panels.shortcuts);
  const migrated = selection.shortcuts;
  if (panels.changed || selection.changed) saveKeyboardShortcuts(migrated);
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
      && !hasActiveShortcutConflict(next, targetId, legacy)
      ? legacy
      : fallback;
    changed = true;
  }

  return { shortcuts: next, changed };
}

// Vague 3 : copier, couper, coller et supprimer n'ont plus qu'une définition,
// partagée par l'arbre, le diagramme et le graphe. Une personnalisation de
// l'ancienne commande d'arbre ou de diagramme devient celle de la commande
// commune ; si les deux avaient été personnalisées différemment, celle de
// l'arbre gagne, parce que c'est la surface historique du Libre. Une valeur
// déjà posée sur la commande commune reste la source de vérité.
const SELECTION_MIGRATIONS = Object.freeze([
  { targetId: 'selectionCopy', legacyIds: ['treeCopy', 'diagramCopy'] },
  { targetId: 'selectionCut', legacyIds: ['treeCut', 'diagramCut'] },
  { targetId: 'selectionPaste', legacyIds: ['treePaste', 'diagramPaste'] },
  { targetId: 'selectionDelete', legacyIds: ['treeDelete', 'diagramDelete'] },
]);

function migrateSelectionShortcuts(shortcuts) {
  const next = { ...shortcuts };
  let changed = false;
  for (const { targetId, legacyIds } of SELECTION_MIGRATIONS) {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === targetId);
    const customized = legacyIds
      .map((legacyId) => normalizeStoredShortcut(next[legacyId]))
      .find((legacy) => legacy && !shortcutEquals(legacy, definition.defaultShortcut));
    if (!normalizeStoredShortcut(next[targetId]) && customized
      && !hasActiveShortcutConflict(next, targetId, customized)) {
      next[targetId] = customized;
      changed = true;
    }
    for (const legacyId of legacyIds) {
      if (legacyId in next) {
        delete next[legacyId];
        changed = true;
      }
    }
  }
  return { shortcuts: next, changed };
}

// Les contextes où une portée est active.
function scopeContexts(scopeId) {
  return SHORTCUT_SCOPES.find((scope) => scope.id === scopeId)?.contexts ?? [];
}

// Deux portées peuvent-elles être actives au même moment ? C'est la seule
// question qui fasse d'une même touche un conflit.
export function scopesOverlap(leftScope, rightScope) {
  if (leftScope === rightScope) return true;
  const right = scopeContexts(rightScope);
  return scopeContexts(leftScope).some((context) => right.includes(context));
}

function effectiveShortcut(shortcuts, definition) {
  return normalizeStoredShortcut(shortcuts?.[definition.id])
    ?? normalizeShortcut(definition.defaultShortcut);
}

// Une commande active en même temps que `actionId` répond-elle déjà à cette
// touche, par son raccourci ou par l'une de ses variantes ?
function hasActiveShortcutConflict(shortcuts, actionId, shortcut, definitions = EDITABLE_DEFINITIONS) {
  const target = SHORTCUT_DEFINITIONS.find((definition) => definition.id === actionId);
  if (!target) return false;
  return definitions.some((definition) => {
    if (definition.id === actionId || !scopesOverlap(definition.scope, target.scope)) return false;
    const effective = effectiveShortcut(shortcuts, definition);
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
  // Sous macOS, Cmd **est** la touche de commande : capturée, elle devient la
  // même commande que Ctrl ailleurs, et le raccourci se partage entre machines.
  const commandIsMeta = commandKeyIsMeta();
  return normalizeShortcut({
    ctrl: event.ctrlKey || (commandIsMeta && event.metaKey),
    shift: event.shiftKey,
    alt: event.altKey,
    meta: commandIsMeta ? false : event.metaKey,
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

// Conflits entre commandes **actives en même temps** : Ctrl+X peut couper des
// nœuds dans le graphe et de l'audio dans l'éditeur audio, mais pas servir
// deux commandes du graphe, ni une commande générale et une commande du graphe.
export function findShortcutConflict(shortcuts, actionId, shortcut) {
  return EDITABLE_DEFINITIONS.find((definition) => (
    hasActiveShortcutConflict(shortcuts, actionId, shortcut, [definition])
  )) || null;
}

const LATIN_LETTER = /^[a-z]$/;

// Une frappe répond-elle à ce raccourci ?
//
// La touche se compare selon sa nature, et c'est ce qui rend les raccourcis
// justes sur un AZERTY comme sur un QWERTY :
//
// - une **lettre** se compare au caractère tapé. Comparée à sa position, la
//   touche `Q` d'un AZERTY — code `KeyA` — déclenchait le raccourci de `A`, et
//   `Ctrl+W` celui de `Ctrl+Z`. La position ne sert que lorsque le caractère
//   n'est pas une lettre latine : un clavier cyrillique garde ainsi `Ctrl+Z`
//   sur la touche où il l'attend ;
// - un **chiffre** et une **touche nommée** (flèches, Suppr, F2…) se comparent
//   à leur position : sur un AZERTY, la touche `1` tape `&` ;
// - un **symbole** se compare au caractère tapé, quelle que soit la touche qui
//   le porte. Ses variantes disent avec quelle touche de Maj il s'obtient.
function shortcutMatchesEvent(event, shortcut) {
  const normalized = normalizeShortcut(shortcut);
  // La commande est Ctrl, ou Cmd sous macOS (voir `platformKeys`).
  const commandIsMeta = commandKeyIsMeta();
  const command = !!event.ctrlKey || (commandIsMeta && !!event.metaKey);
  if (command !== normalized.ctrl) return false;
  if (!!event.shiftKey !== normalized.shift) return false;
  if (!!event.altKey !== normalized.alt) return false;
  if (!commandIsMeta && !!event.metaKey !== normalized.meta) return false;
  const eventKey = normalizeKey(event.key);
  if (LATIN_LETTER.test(normalized.key)) {
    return LATIN_LETTER.test(eventKey)
      ? eventKey === normalized.key
      : !!normalized.code && event.code === normalized.code;
  }
  const positional = /^(Digit|Numpad)/.test(normalized.code) || normalized.key.length > 1
    || (!normalized.key && !!normalized.code);
  if (positional) {
    return (!!normalized.code && event.code === normalized.code)
      || (normalized.key.length > 1 && eventKey === normalized.key);
  }
  return !!normalized.key && eventKey === normalized.key;
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
// `scope` restreint la recherche à une portée, ou à plusieurs s'il est un
// tableau ; sans lui, toutes les portées sont parcourues.
export function findShortcutAction(event, shortcuts, scope = null) {
  const scopes = scope === null ? null : [].concat(scope);
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.readOnly) continue;
    if (scopes && !scopes.includes(definition.scope)) continue;
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
