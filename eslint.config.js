// Configuration ESLint (flat) ciblée sur la détection de CODE MORT intra-fichier
// (imports et variables inutilisés) — complément de `knip` (exports/fichiers/deps
// morts cross-fichier) — et sur les accès directs interdits par les conventions
// (stockage, dialogues natifs, console). Volontairement minimale : pas de règles de
// style, pour que `npm run lint` reste un signal de défaut, pas du bikeshed.
//
// `react/jsx-uses-vars` est indispensable : sans lui, un composant utilisé seulement
// en JSX (`<Foo />`) serait faussement signalé comme import inutilisé.

import i18next from 'eslint-plugin-i18next';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

// Accès directs remplacés par les façades du projet.
const STORAGE_MESSAGE = 'Passer par src/store/persistentSettings.js (clés déclarées).';
const DIALOG_MESSAGE = 'Passer par showErrorDialog, showConfirmDialog ou showChoiceDialog.';
const restrictedGlobals = [
  'error',
  { name: 'localStorage', message: STORAGE_MESSAGE },
  { name: 'sessionStorage', message: STORAGE_MESSAGE },
  { name: 'alert', message: DIALOG_MESSAGE },
  { name: 'confirm', message: DIALOG_MESSAGE },
  { name: 'prompt', message: DIALOG_MESSAGE },
];
const restrictedProperties = [
  'error',
  ...['window', 'globalThis'].flatMap((object) => [
    { object, property: 'localStorage', message: STORAGE_MESSAGE },
    { object, property: 'sessionStorage', message: STORAGE_MESSAGE },
    { object, property: 'alert', message: DIALOG_MESSAGE },
    { object, property: 'confirm', message: DIALOG_MESSAGE },
    { object, property: 'prompt', message: DIALOG_MESSAGE },
  ]),
];

const unusedVarsRule = [
  'warn',
  { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
];

const config = [
  { ignores: ['dist/**', 'src-tauri/**', 'node_modules/**'] },
  // Les `eslint-disable` existants visent des règles de style non activées ici
  // (no-console…) : ne pas les signaler comme orphelins.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks, 'unused-imports': unusedImports },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // Règle enregistrée (valide les eslint-disable du code) mais non reportée :
      // hors périmètre « code mort », et bruyante. Activable plus tard si voulu.
      'react-hooks/exhaustive-deps': 'off',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': unusedVarsRule,
      'no-restricted-globals': restrictedGlobals,
      'no-restricted-properties': restrictedProperties,
      'no-console': ['error'],
    },
  },
  {
    // Seules façades autorisées à toucher le stockage et la console.
    files: ['src/store/persistentSettings.js'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    files: ['src/utils/logger.js'],
    rules: { 'no-console': 'off' },
  },
  {
    // Liste explicite des surfaces raccordées, à étendre par domaine.
    files: ["src/components/AdvancedGraphCanvas/AdvancedGraphCanvas.jsx","src/components/AdvancedGraphCanvas/GraphCanvasStage.jsx","src/components/AdvancedGraphCanvas/GraphInspector.jsx","src/components/AdvancedGraphCanvas/GraphNodeOverlays.jsx","src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx","src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx","src/components/AdvancedGraphCanvas/graphSurfaceCapture.js","src/components/AdvancedWorkspace/AdvancedDialog.jsx","src/components/AdvancedWorkspace/AdvancedWorkspace.jsx","src/components/AdvancedWorkspace/CreateConstructionDialog.jsx","src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx","src/components/AdvancedWorkspace/useGraphArrangement.js","src/hooks/graphCopyFlow.js","src/hooks/useAdvancedProjectEntry.js","src/store/advancedAuthoring/constructions.js","src/store/advancedAuthoring/defaultNodeNames.js","src/store/advancedGraphView/advancedViewSession.js","src/store/advancedGraphView/graphPresentation.js","src/store/advancedGraphView/graphViewModel.js","src/store/graphCopy.js",
      "src/components/editors/EndMessagePlaybackControl.jsx",
      "src/components/editors/EndNodeEditor.jsx",
      "src/components/editors/MenuEditor.jsx",
      "src/components/editors/MultiEditor.jsx",
      "src/components/editors/NativeGraphEditor.jsx",
      "src/components/editors/RootEditor.jsx",
      "src/components/editors/StoryEditor.jsx",
      "src/components/editors/story/AfterPlaySection.jsx",
      "src/components/editors/story/DuringPlaySection.jsx",
      "src/components/editors/story/EndSequenceEditor.jsx",
      "src/components/editors/story/storyUtils.jsx",
      "src/store/packMetadataModel.js",
      "src/store/projectModel/index.js",
      "src/components/editors/AudioField.jsx",
      "src/components/editors/ImageField.jsx",
      "src/components/editors/RefEditor.jsx",
      "src/components/editors/ZipEditor.jsx",
      "src/components/editors/story/StoryDisclosure.jsx",
      'src/components/ModeSelector/ModeSelector.jsx',
      'src/components/AggregatePacks/AggregatePacksFunnel.jsx',
      'src/components/AggregatePacks/aggregateProject.js',
      'src/components/funnels/FunnelDoneState.jsx',
      'src/components/funnels/FunnelFooter.jsx',
      'src/components/funnels/FunnelGenerationState.jsx',
      'src/components/funnels/FunnelShell.jsx',
      'src/components/funnels/FunnelStepper.jsx',
      'src/components/funnels/funnelNavigation.js',
      'src/components/layout/PackNameModal.jsx',
      'src/hooks/useProjectLifecycle.js',
      'src/store/projectSaveName.js',
      'src/store/projectStorage.js',
      'src/store/projectStore.js',
      'src/store/projectModel/schema.js',
      'src/tabs/OptionsTab/InterfaceSection.jsx', 'src/tabs/OptionsTab/OptionsSectionNav.jsx',
      'src/App.jsx',
      'src/components/AppModals.jsx',
      'src/components/AppShell.jsx',
      'src/components/BottomWorkspacePanel/BottomWorkspacePanel.jsx',
      'src/components/FloatingSimulator/FloatingSimulator.jsx',
      'src/components/common/Dialog.jsx',
      'src/components/common/ReleaseNotesModal.jsx',
      'src/components/common/Toggle.jsx',
      'src/components/common/Tooltip.jsx',
      'src/components/layout/ProjectMenuPopover.jsx',
      'src/components/layout/TitleBar.jsx',
      'src/components/layout/Toolbar.jsx',
      'src/components/structure/PanelResizeHandle.jsx',
      'src/components/structure/StructureActionsBar.jsx',
      'src/components/structure/StructureActionsOverflow.jsx',
      'src/components/structure/StructurePanel.jsx',
      'src/tabs/EmulatorTab/FlatImage.jsx',
      'src/tabs/EmulatorTab/FlatSimulator.jsx',
      'src/tabs/EmulatorTab/LuniiShell.jsx',
      'src/workspace/WorkspaceEmptyState.jsx',
      'src/workspace/WorkspaceView.jsx',
      'src/hooks/saveBeforeLeave.js',
      'src/hooks/useAppBootstrap.js',
      'src/hooks/useAppDerivedState.js',
      'src/hooks/useWindowCloseGuard.js',
      'src/hooks/useWorkSession.js',
      'src/store/toolbarModel.js',
      'src/config/releaseNotes.js',
      "src/components/TreePanel/ContextMenu.jsx",
      "src/components/TreePanel/TreeDisplayPopover.jsx",
      "src/components/TreePanel/TreeDragOverlay.jsx",
      "src/components/TreePanel/TreeNode.jsx",
      "src/components/TreePanel/TreePanel.jsx",
      "src/components/TreePanel/TreeSearchBar.jsx",
      "src/components/TreePanel/treeContextMenuActions.jsx",
      "src/components/TreePanel/useTreeNavigationBadges.js",
      "src/components/tree/NodeColorFilterChips.jsx",
      "src/components/tree/NodeColorPicker.jsx",
      "src/components/tree/nodeColorFilter.js",
      "src/components/tree/refDisplay.js",
      "src/components/tree/treeNavigationBadges.js",
      "src/components/diagram/DiagramPanel.jsx",
      "src/components/diagram/FullDiagramNode.jsx",
      "src/components/diagram/FullDiagramTree.jsx",
      "src/components/diagram/flowDiagramLayout.js",
      "src/components/diagram/fullDiagramFocus.js",
      "src/components/diagram/diagram/DiagramLegend.jsx",
      "src/components/diagram/diagram/DiagramSearch.jsx",
      "src/components/diagram/diagram/DiagramViewToggles.jsx",
      "src/components/diagram/diagram/DiagramZoomControls.jsx",
      "src/components/diagram/diagram/StructureDiagramLayer.jsx",
      "src/components/diagram/diagram/StructureFocusBar.jsx",
      "src/components/diagram/diagram/StructureLevelSummaryNode.jsx",
      "src/components/diagram/diagram/diagramContextMenu.jsx",
      "src/components/diagram/diagram/diagramSearchFilter.js",
      "src/components/diagram/diagram/diagramSelection.js",
      "src/components/diagram/diagram/localEndStepPresentation.js",
      "src/components/diagram/diagram/navigationPresentation.js",
      "src/components/diagram/diagram/storyGroupLayout.js",
      "src/components/diagram/diagram/structureLevelLayout.js",
      "src/components/diagram/diagram/structurePresentation.js",
      "src/store/projectModel/menuDepth.js",
      "src/store/generatedNavigation.js",
      'src/utils/frenchText.js',
    ],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', {
        mode: 'all',
        'jsx-attributes': { exclude: ['className', 'id', 'htmlFor', 'type', 'key', 'value', 'data-.*', 'aria-hidden', 'role', 'aria-modal', 'aria-labelledby', 'aria-orientation', 'aria-live', 'aria-haspopup', 'aria-keyshortcuts', 'variant', 'size', 'placement', 'tone', 'src', 'href', 'target', 'rel', 'viewBox', 'd', 'fill', 'stroke', 'strokeLinecap', 'strokeLinejoin', 'strokeWidth', 'panelClass', 'cssVar', 'filenameHint', 'ttsFilenameHint', 'fieldId', 'hostSelector'] },
        'object-properties': { exclude: ['key', 'd', 'paddingLeft', 'rootMargin','id', 'labelKey', 'className', 'role', 'variant', 'kind', 'value', 'cancelValue', 'color', 'background', 'fontFamily', 'timeZone', 'day', 'month', 'year', 'scope', 'group', 'owner', 'slot', 'priority', 'placement', 'panelClass', 'cssVar', 'sessionMode'] },
        // Clés de traduction, imports et enums techniques des composants pilotes.
        callees: { exclude: ['t', 'useTranslation', 'useCommonTranslation', 'logger.*', 'invoke', 'modals.*', 'createElement', 'querySelector', 'querySelectorAll', 'closest', 'matches', 'addEventListener', 'removeEventListener', 'listen', 'classList.*', 'write', 'readSetting', 'read', 'replace', 'replaceAll', 'normalize', 'join', 'includes', 'startsWith', 'split'] },
        // Enums/IDs fermés, classes CSS, séparateurs et marques ; aucune prose UI.
        // Identifiants de transport/vue et glyphes sans prose, familles fermées du lot 4.3b.
        words: { exclude: [":", "\\u0000", "(?:-start|-exit|story_home_step|story_play|global-end|inherited|implicit|reference|same-row-return)", "(?:sep|node|tree|diagram|split|assemble|selection|warn|default|night|end|contextual|configured|curve|sequence|prompt|exit|moon|stop|story-group|menu_target_missing|ProjectMenuDepthError|end-night|night-end-node|imported-night-prompt|insert-before|insert-after|auto-next-settings|open-auto-next-settings|native-graph-root|native-graph|continuation)", "(?:container|local-end|structure|return|sequence-return|prompt-return|end-node-return|end-node-home|home):.*", "[↩↪↖⧉◇⇒▤☾■»−⌗]", "[0-9]+px", "[MLC]", ":[0-9]+","tree:.*", "(?:__mixed__|__none__|end-node|autoNext|nightModeAudio|rootAudio|rootImage|autoGenerateRootImage|nativeGraph|itemAudio|itemImage|afterPlaybackPromptAudio|audio|image|zipPath|stage|pause|wheel|autoplay|fr|title|description|center|smooth|nearest|empty|generate-text|root:coverImage)", "[→⌄#]+", "(?:NFC|convention|legacy|\\[by_|\\.zip|unknown|collision|free|uuid|minAge|start|root:thumbnailImage|addSilence|add|normalize|ref|story_home_step:|story_play:|story:|menu:|returnAfterPlay|returnOnHome|titleReturnOnHome|afterPlaybackPromptOkTarget|afterPlaybackPromptHomeTarget|return|continue|lossy|branching-graph|NFKC|_|nouveau-projet|entry_missing|empty_selection|mon-projet|projet|new-project|my-project|nuovo-progetto|mio-progetto|progetto|edit-pack:land-error|edit|podcast|youtube|aggregate|check|open|collect|piper_generate_audio|xtts_generate_audio|generating|agregation|done|active|todo|neutral|violet|%|current)", "settings:.*", "common:.*", "home:.*", "catalogue:.*", "(?:settings|common|primary|danger|danger-outline|ghost|secondary|error|warning|info|function|object|boolean|string|pack|simple|root|ok|home|story|menu|zip|cancel|save|discard|delete|stay|quit|prefs|credits|record|tts|media|document|ephemeral|project|advanced|hierarchical|below|above|floating|panel|canvas|loading|failed|applied|new|fix|chore|exports|auto|hidden|none|transparent|pointerdown|keydown|resize|scroll|ended|Tab|Escape|ArrowLeft|ArrowRight|ArrowDown|ArrowUp|Home|End|true|false|mixed|on|off|editor|export|held|busy|queue|validation|generate|undo|redo|workspace|plein|colonne|header|oe|ae|NFKD|languageChanged|podcastImport|podcastFunnel|aggregatePacks|packChecker|catalogue|editPack|harmonizeLoudness|silenceMode|leadingSilenceSec|trailingSilenceSec|catalogImage|thumbnailImage|newProject|returnToCatalogue|openProject|openPack|saveProject|saveProjectAs|continueInGraph|toggleTree|toggleSettings|toggleDiagram|toggleNodeList|toggleInspector|toggleValidation|openPreferences|treeColor)", "(?:chrome-|workspace-|bottom-workspace-|is-)[a-z0-9 -]+", "[\\\\/]+", "[()·×✓▾▶⏸⌂⋮—| +.0-9v-]+", "Story Studio", "STORY STUDIO ·", "— hugs11"] },
        'should-validate-template': true,
      }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    plugins: { 'unused-imports': unusedImports },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': unusedVarsRule,
    },
  },
];

const literalRule = config.find((entry) => entry.rules?.['i18next/no-literal-string']).rules['i18next/no-literal-string'];

const graphFiles = [

  "src/store/projectModel/mediaBindings.js",
  "src/store/projectModel/authoring.js",
  "src/store/projectModel/advancedGestures.js",
  "src/store/advancedAuthoring/mediaDrop.js",
  "src/store/advancedAuthoring/graphLinkDraft.js",
  "src/store/advancedAuthoring/diagnosticResolutions.js",
  "src/store/advancedAuthoring/authoringPlans.js",
  "src/hooks/useAdvancedAuthoring.js",
  "src/components/AdvancedWorkspace/graphContextMenuActions.jsx",
  "src/components/AdvancedWorkspace/connectionRows.jsx",
  "src/components/AdvancedWorkspace/StageWheel.jsx",
  "src/components/AdvancedWorkspace/StageEditor.jsx",
  "src/components/AdvancedWorkspace/StageDestinations.jsx",
  "src/components/AdvancedWorkspace/StageArrivals.jsx",
  "src/components/AdvancedWorkspace/RemoveOptionDialog.jsx",
  "src/components/AdvancedWorkspace/GraphSelectionEditor.jsx",
  "src/components/AdvancedWorkspace/GestureFeedback.jsx",
  "src/components/AdvancedWorkspace/DeleteSelectionDialog.jsx",
  "src/components/AdvancedWorkspace/DeleteNodeDialog.jsx",
  "src/components/AdvancedWorkspace/ActionEditor.jsx",  "src/components/AdvancedWorkspace/GraphLinkDialog.jsx",
  "src/components/AdvancedWorkspace/NodePicker.jsx",
  "src/components/AdvancedWorkspace/MediaSlotEditor.jsx",
  "src/components/AdvancedWorkspace/NodeNameEditor.jsx",
  "src/components/AdvancedWorkspace/SquareOneRepairForm.jsx",
  "src/components/AdvancedWorkspace/ActionSelectionFields.jsx",
  "src/components/AdvancedWorkspace/LandingSelect.jsx",
  "src/components/AdvancedWorkspace/ListenFromActionDialog.jsx",
  "src/components/AdvancedWorkspace/ControlsEditor.jsx",
  "src/components/AdvancedGraphCanvas/AdvancedGraphCanvas.jsx",
  "src/components/AdvancedGraphCanvas/GraphCanvasStage.jsx",
  "src/components/AdvancedGraphCanvas/GraphInspector.jsx",
  "src/components/AdvancedGraphCanvas/GraphNodeOverlays.jsx",
  "src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx",
  "src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx",
  "src/components/AdvancedGraphCanvas/graphSurfaceCapture.js",
  "src/components/AdvancedWorkspace/AdvancedDialog.jsx",
  "src/components/AdvancedWorkspace/AdvancedWorkspace.jsx",
  "src/components/AdvancedWorkspace/CreateConstructionDialog.jsx",
  "src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx",
  "src/components/AdvancedWorkspace/useGraphArrangement.js",
  "src/hooks/graphCopyFlow.js",
  "src/hooks/useAdvancedProjectEntry.js",
  "src/store/advancedAuthoring/constructions.js",
  "src/store/advancedAuthoring/defaultNodeNames.js",
  "src/store/advancedGraphView/advancedViewSession.js",
  "src/store/advancedGraphView/graphPresentation.js",
  "src/store/advancedGraphView/graphViewModel.js",
  "src/store/graphCopy.js"
];
// Exceptions techniques fermées du graphe : aucune prose de l’application.
const graphLiteralConfig = { files: graphFiles, plugins: { i18next }, rules: {
 'i18next/no-literal-string': ['error', { ...literalRule[1],
  'object-properties': { exclude: [...literalRule[1]['object-properties'].exclude, 'font', 'textAlign', 'textBaseline', 'left', 'top', '--.*'] },
  callees: { exclude: [...literalRule[1].callees.exclude, 'setAttribute', 'getContext', 'toDataURL', 'requireText', 'requireRank', 'requireOneOf'] },
  words: { exclude: [...literalRule[1].words.exclude, 'graph:.*', 'message', "action","undefined","ecran-","advanced-wire-","advanced-slot-","advanced-editor__connection-icon","has-thumbnail","advanced-editor__connection-icon--action","insert-example","square-one","controls","orphan-action","unsupported-kind","no-stage","no-path","/authoring/payload","/authoring/mediaBindings/","path","assetRef","resolved","missing","create_advanced_document","acquire_advanced_pack_document","assess_advanced_payload_readiness","apply_advanced_gesture","\u0000","wheel","ok","home","pause","autoplay","title","version","description","uuid","packIdentity","audio","image","string","set","null","absent","stage","created-stage","select","retarget","remove","stageUuid","slot","kind","id","set-stage-controls","members","set-stages-controls","complete","set-stage-transition","connect-stage-to-empty-action","actionNode","insert-action-option","actionId","index","set-action-option-target","ordinal","newPositionOfOld[]","reorder-action-options","remove-action-option","repoint-media","set-stage-media","field","create-stage","create-action","create-construction","create-linked-node","paste-subgraph","set-node-name","paths[]","set-node-color","delete-stage","delete-subgraph","delete-action","set-square-one","set-document-metadata","set-authored-position","set-authored-positions","apply-view-layout","apply-layout-to-authoring","scale","omit","refuse","outOfRange","set-position-export-disposition","scale-to-short-range","omit-explicitly","preserve-raw-accept-dantsu-loss","disposition","set-opaque-export-disposition","member.path","member.key","member.sourceOccurrence","preserve-untested","remove-explicitly","promote-after-proof","never-emit-standard","flatten-known-group","groupId", '(?:absent|null|random|dangling|ready|-fixed-choice|stage-to-action|action-to-stage)', '(?:OK|HOME|STALE_MEDIA_TARGET|outgoing|incoming|entry|invalid|valid|application/octet-stream|set-stage-media|refuse|createStage|createAction|createConstruction|scene|members|set|nothing-pending|viewport|focus|okTransition|homeTransition|read_advanced_graph_view|copy_project_to_graph|verify_project_graph_copy|advanced:create-error|advanced:land-error)', '(?:px|position:|advanced-option-|\\.mbah|\\.mbah \\(|[0-9]+[ :]*(?:px \"Space Grotesk\", sans-serif)?|px \"Space Grotesk\", sans-serif)', '[‹›…,]', '\\)\\.mbah' ] },
 }] } };

const importFiles = ['src/store/projectModel/mediaBindings.js', 'src/store/projectModel/codec.js', 'src/store/projectModel/envelope.js', 'src/components/common/SaveProgressModal.jsx', 'src/components/GenerateModal/GenerateProgressModal.jsx', 'src/hooks/mediaLibraryImport.js', 'src/hooks/useImportSession.js', 'src/hooks/useMediaImport.js', 'src/hooks/useOsFileDrop.js', 'src/hooks/useProjectLoading.js', 'src/store/projectIO.js', 'src/store/unpackProject.js', 'src/utils/youtubeErrors.js', 'src/components/PodcastImport/PodcastImportFunnel.jsx', 'src/components/PodcastImport/PodcastImportModal.jsx', 'src/components/YoutubeImport/YoutubeImportFunnel.jsx', 'src/components/EditPack/BundleChildStep.jsx', 'src/components/EditPack/EditPackFunnel.jsx', 'src/components/EditPack/ImportErrorNotice.jsx', 'src/components/EditPack/bundleChildren.js', 'src/components/EditPack/graphOnlyNotice.js', 'src/components/EditPack/importErrorPresentation.js', 'src/components/common/ImportNoticeToast.jsx', 'src/hooks/importedUuidRevision.js', 'src/hooks/useFileDialog.js', 'src/store/importedNames.js'];
const importLiteralConfig = { files: importFiles, plugins: { i18next }, rules: {
  'i18next/no-literal-string': ['error', { ...literalRule[1],
    callees: { exclude: [...literalRule[1].callees.exclude, 'importPresentationError'] },
    words: { exclude: [...literalRule[1].words.exclude, 'import:.*', 'native:.*',
      // Codes stables et pointeurs/champs techniques du codec, jamais de prose visible.
      '[A-Z][A-Z0-9_]*', '/[A-Za-z][A-Za-z0-9/]*', '[<>]',
      '(?:mediaTags|mediaLibraryPaths|ProjectFormatError|message|schemaVersion|authoringMode|authoring|rootItems|menus|nodes|edges|stage_id_map|stageIdMap|source_value|sourceValue|preparedGraphDocument|editorState|status|entries|assetRef|path)',
      'YouTube', 'Podcast', '(?:racine|asset|mbah|images|archives|assets)',
      // Identifiants de logs et gabarits de chemins disque, sans phrase UI.
      ':import-error', '_assets', '\\.mbah', '\\.tmp-', '-consolidee\\.mbah', '__', '(?:importing|url|episodes|language|cgu|analyzing)', '[–]',
      // Enums de phases/contextes, clés de propriété, extensions et glyphe de fermeture.
      '(?:readOnly|unsupported|bundle|file|folder|simulate|graph|technicalDetail|png|jpg|jpeg|webp|bmp|gif|mp3|ogg|wav|m4a|webm|flac|7z|json)', '✕'] },
  }],
} };

// Lot 4.5 — domaine Médias. Exceptions fermées : identifiants, chemins, codes et glyphes.
const mediaFiles = [
  'src/components/AudioAssemblyModal/AudioAssemblyModal.jsx',
  'src/components/AudioEditorModal/AudioEditorFadeOverlays.jsx',
  'src/components/AudioEditorModal/AudioEditorModal.jsx',
  'src/components/AudioEditorModal/AudioEditorTransportBar.jsx',
  'src/components/AudioEditorModal/fadeUtils.js',
  'src/components/AudioEditorModal/useStagedAudioEdit.js',
  'src/components/AudioEditorModal/useWaveformViewport.js',
  'src/components/AudioSplitterModal/AudioSplitterModal.jsx',
  'src/components/ImageEditorModal/ImageEditorModal.jsx',
  'src/components/ImageEditorModal/LevelsControl.jsx',
  'src/components/ImageEditorModal/imageEditorExport.js',
  'src/components/ImageEditorModal/imageFilters.js',
  'src/components/MediaExplorer/KindIcon.jsx',
  'src/components/MediaExplorer/MediaDeleteDialog.jsx',
  'src/components/MediaExplorer/MediaExplorerContent.jsx',
  'src/components/MediaExplorer/MediaExplorerImpl.jsx',
  'src/components/MediaExplorer/MediaPopover.jsx',
  'src/components/MediaExplorer/MediaSelectionBar.jsx',
  'src/components/MediaExplorer/MediaThumb.jsx',
  'src/components/MediaExplorer/MediaTile.jsx',
  'src/components/MediaExplorer/MediaToolResultBanner.jsx',
  'src/components/MediaExplorer/TagSection.jsx',
  'src/components/MediaExplorer/UsageBadge.jsx',
  'src/components/MediaExplorer/helpers.js',
  'src/components/MediaExplorer/useColumnWidths.js',
  'src/components/MediaExplorer/useMediaImageEdit.js',
  'src/components/MediaSubscriptions/MediaSubscriptionsPanel.jsx',
  'src/components/MediaSubscriptions/useSubscriptionFollow.js',
  'src/components/MissingMediaRelink/MissingMediaRelinkModal.jsx',
  'src/components/RecordModal/RecordModal.jsx',
  'src/components/SessionMediaTriage/SessionMediaTriageModal.jsx',
  'src/components/layout/PackAudioProcessingFields.jsx',
  'src/config/audioProcessing.js',
  'src/store/projectModel/audioTransformations.js',
  'src/hooks/useMediaSubscriptions.js',
  'src/hooks/useMediaToolBridge.js',
  'src/hooks/useMediaTransferHandlers.js',
  'src/hooks/useMissingMediaRelink.js',
  'src/hooks/useProjectMediaDirectory.js',
  'src/hooks/useSessionMediaTriage.js',
  'src/store/imageEditMetadata.js',
  'src/store/mediaLibrary.js',
  'src/store/mediaSubscriptionSource.js',
  'src/store/mediaSubscriptions.js',
  'src/store/mediaToolContext.js',
  'src/store/mediaToolSurface.js',
  'src/store/missingMediaRelink.js',
  'src/store/projectMediaOutput.js',
  'src/store/projectMediaPaths.js',
  'src/utils/audioPlayer.js',
];
const mediaLiteralConfig = { files: mediaFiles, plugins: { i18next }, rules: {
  'i18next/no-literal-string': ['error', { ...literalRule[1],
    'jsx-attributes': { exclude: [...literalRule[1]['jsx-attributes'].exclude, 'i18nKey', 'inputMode', 'min', 'max', 'step', 'spellCheck', 'aria-controls', 'aria-pressed', 'aria-invalid', 'aria-describedby', 'strokeWidth', 'x', 'y'] },
    'object-properties': { exclude: [...literalRule[1]['object-properties'].exclude, 'mode', 'status', 'source', 'field', 'origin', 'tool', 'code', 'mimeType', 'type', 'behavior', 'block', 'cursor', 'position', 'inset', 'display', 'alignItems', 'justifyContent', 'flexDirection', 'backdropFilter', 'maxWidth', 'padding', 'margin', 'paddingLeft', 'fontSize', 'lineHeight', 'opacity', 'left', 'top', 'width', 'zIndex', 'gap', 'height', 'borderColor', 'labelKey', 'preload', 'action', 'phase', 'state', 'nativeGraph', 'previewStatus', 'kindOrder'] },
    callees: { exclude: [...literalRule[1].callees.exclude, 'translateMedia', 'mediaRef', 'mediaRefusal', 'importPresentationError', 'useProjectMediaDirectory', 'setPhase', 'setPreviewStatus', 'setApplyMode', 'setView', 'setFilter', 'setSortDir', 'setActiveFilters', 'copySelectedAudio', 'handleStageAction', 'scheduleFadePreview', 'onOpenFadePopover', 'onSetFadeValue', 'previewRange', 'dispatchEvent', 'CustomEvent', 'Set', 'Blob', 'MediaRecorder', 'getContext', 'toBlob', 'join', 'joinPath', 'resolve_project_folder', 'styleRegionHandles', 'withProjectMediaOutput', 'beginProjectMediaOutput', 'pathKey', 'padStart', 'toLowerCase', 'endsWith', 'lastIndexOf', 'indexOf', 'map', 'test', 'onAddMediaTag', 'readImageEditMetadata', 'URL', 'parsed.searchParams.get', 'onChange', 'updateField', 'emit', '_emit', 'on', 'once', 'off', 'ws.on', 'wsRegions.on', 'addRegion', 'wsRegions.addRegion', 'concat_audio_files', 'split_audio_segments', 'save_recording', 'fetch_podcast_feed', 'fetch_youtube_list', 'update_ytdlp', 'remove', 'mkdir', 'writeFile', 'readFile'] },
    words: { exclude: [...literalRule[1].words.exclude, 'media:.*', 'native:.*', 'import:.*',
      // Identifiants techniques du domaine (provenances, dossiers, codes, modes) et formats.
      '[A-Z][A-Z0-9_]*', 'YouTube', 'Podcast', 'XTTS', 'ComfyUI', 'FFmpeg', '(?:fichiers-importes|enregistrements|images-generees|voix-generees|zips-extraits)',
      '(?:mediaexplorer|mediaPanel|mediaSearch|grid|list|all|image|audio|zip|ai|imported|recorded|unused|archive|other|library|split|assemble|replace-stories-with-assembly|countdown|recording|preview|saving|idle|loading|playing|paused|ended|trim|cut|restore|ignored|pending|ready|missing|found|ambiguous|resolved|remaining|in|out|asc|desc|name|usage|size|dim|dur|fmt|date|path|tags|tool_missing|webkitAudioContext|auto|instant|nearest|col-resize|copy|drop|retry|media|playlist|channel|inactive|active|checking|error|warning|danger|danger-outline|ghost|icon|sm|above|below|primary)',
      '(?:audio-selection-region|audio-fade-in-region|audio-fade-out-region|audio-cut-region|audio-cut-history-region|audio-split-selection-region|media-drag-over|media-drop|is-media-dragging|is-drop-over|is-over-target|is-active|is-partial|is-zero|is-unknown|is-missing|is-selected|is-popover-active|blob:|story-studio:subscriptions-saved|mbah|flac|webm|png|jpg|jpeg|webp|bmp|gif|mp3|ogg|wav|m4a|aac|7z|json|\\.webm|\\.flac|\\.edit\\.json|\\.story-studio-image-edits|_assemble\\.flac|rec_|2d|image/png|image/jpeg|image/webp|image/bmp|image/gif|audio/webm;codecs=opus|media-tool-|advanced-ref:|recursive)',
      '(?:rgba?\\(.*\\)|#[0-9a-fA-F]{3,8}|hsl\\(.*\\)|var\\(.*\\)|[0-9.]+(?:px|%|vw|s)?|--:--|—|…|[↑↓↗↘⊞≡×✓–•{}!?°]|\\|▶|▶\\||Ctrl\\+.*|1 s|No audio loaded|\\[.*\\])',
      // Séparateurs, puces et identifiants de transport/DOM sans prose.
      '[\\s•_-]*', '(?:\\\\n|\\s|•)*', 'ffmpeg', 'resolve_project_folder', '(?:me-list-row|media-tile|__workspace__|action-not-allowed|unknown-action|mutation-refused|missing-output|mediaBinding|base|nightModeReturn|nightModeHomeReturn|px|-error|-durations|-durations-note|\\s*s)',
    ] },
  }],
} };

const aiLiteralConfig = { ...mediaLiteralConfig, files: [
  "src/components/GenerateVoiceModal/GenerateVoiceModal.jsx",
  "src/components/SDGenerateModal/SDGenerateModal.jsx",
  "src/components/SDQueuePanel/SDQueuePanel.jsx",
  "src/components/SDQueuePanel/useQueueColumnWidths.js",
  "src/components/TextImageGenerator/TextImagePromptModal.jsx",
  "src/components/TextImageGenerator/drawTextImage.js",
  "src/components/TextImageGenerator/generateTextImage.js",
  "src/hooks/useAiGeneration.js",
  "src/hooks/useAiJobUsage.js",
  "src/hooks/useSDJobs.js",
  "src/hooks/useXttsJobs.js",
  "src/store/aiJobLabels.js",
  "src/store/sdStore.js",
  "src/store/xttsStore.js"
], rules: { 'i18next/no-literal-string': ['error', { ...mediaLiteralConfig.rules['i18next/no-literal-string'][1],
  callees: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].callees.exclude, 'aiRef', 'translateAi', 'setBottomPanelTab', 'setText'] },
  words: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].words.exclude, 'ai:.*', '600', 'px sans-serif', 'edited_', '\\.png', ';', 'Piper', 'GPU CUDA', 'CPU', '✕', '▸', '-2px', '600 .*px sans-serif', 'edited_.*\\.png', ' ; ', ':homeStep:image', '(?:piper|xtts|cuda|cpu|en|es|de|it|pt|submitting|running|mediaLibrary|rootStory|storySequence|storyHomeStep|afterPlaybackSequence|afterPlaybackHomeStep|coverAudio|result|target|status|actions|name|Enter|middle|2-digit|100%|voix-générées/|lunii_style, simple illustration, black and white line art, grayscale, children book style, |color, photo, realistic, watermark, text|600 12px sans-serif)', '(?:sd-queue-drag-ghost|is-drop-over|is-over-target|--progress)', '[0-9.]+px sans-serif', '\\?' ] },
}] } };
const productionLiteralConfig = { ...mediaLiteralConfig, files: [
  "src/components/RenderQueuePanel/RenderQueuePanel.jsx",
  "src/components/production/AdvancedJobReport.jsx",
  "src/components/production/ProductionReport.jsx",
  "src/components/common/SaveProgressModal.jsx",
  "src/hooks/usePackGeneration.js",
  "src/hooks/useRenderQueueExecutor.js",
  "src/hooks/useSaveProgress.js",
  "src/store/production/advancedProduction.js",
  "src/store/production/advancedRenderWork.js",
  "src/store/production/packAudioOptions.js",
  "src/store/production/productionGates.js",
  "src/store/production/productionReport.js",
  "src/store/production/productionRouting.js",
  "src/store/production/renderQueueWork.js"
], rules: {
  'i18next/no-literal-string': ['error', { ...mediaLiteralConfig.rules['i18next/no-literal-string'][1],
    callees: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].callees.exclude, 'productionRef', 'translateProduction'] },
    words: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].words.exclude, 'production:.*', '(?:2-digit|copied|snapshot|manual|autosave|save|save-as|path-null|not-found|binding-absent)', '[✕▲▼]'] },
  }],
} };

// Lot 4.9 — vérificateur et rapports. Exceptions fermées : clés, identifiants,
// unités techniques, gabarits CSS/HTML de l'export et glyphes ; aucune prose.
const checkerLiteralConfig = { ...mediaLiteralConfig, files: [
  "src/components/CommunityPackChecker/CommunityPackChecker.jsx",
  "src/components/CommunityPackChecker/CommunityPackCheckerFunnel.jsx",
  "src/components/CommunityPackChecker/CommunityPackConforming.jsx",
  "src/components/CommunityPackChecker/CommunityPackMetadataModal.jsx",
  "src/components/CommunityPackChecker/communityPackExports.js",
  "src/components/CommunityPackChecker/packCheckerFormat.js",
  "src/components/CommunityPackChecker/packCheckerIssueClassification.js",
  "src/components/CommunityPackChecker/packCheckerMeasures.jsx",
  "src/components/CommunityPackChecker/useCommunityPackChecker.js",
  "src/components/AdvancedWorkspace/DiagnosticsPanel.jsx",
  "src/components/AdvancedWorkspace/ExportReport.jsx",
  "src/components/AdvancedWorkspace/ZipReviewPanel.jsx",
  "src/components/layout/ValidationPill.jsx",
  "src/hooks/useAdvancedReadiness.js",
  "src/hooks/useAdvancedExport.js",
  "src/store/advancedExport/displayedLayout.js",
  "src/store/advancedExport/exportOutcome.js",
  "src/store/advancedExport/exportReadiness.js",
  "src/store/advancedExport/exportRequest.js",
  "src/store/packIdentityCheck.js",
  "src/store/projectValidation.js",
  "src/store/validationMessages.js",
  "src/utils/packConvention.js"
], rules: {
  'i18next/no-literal-string': ['error', { ...mediaLiteralConfig.rules['i18next/no-literal-string'][1],
    'object-properties': { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1]['object-properties'].exclude, 'icon'] },
    // `html` : balisage de l'export HTML, dont chaque texte passe par t() et escapeHtml.
    // Champs de validation (missingField…) : identifiants internes traduits par code.
    // `warn` : journal interne de la promotion de disposition, jamais affiché.
    callees: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].callees.exclude, 'translateChecker', 'checkerRef', 'html', 'verdict', 'issueHasMeasure', 'onExportReport', 'onExportLog', 'exportReport', 'missingField', 'brokenField', 'missingTarget', 'emptyTarget', 'warn', 'Object.defineProperty', 'advancedGestures.*'] },
    words: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].words.exclude, 'checker:.*', 'home:.*', 'production:.*',
      // États, sous-types et identifiants fermés du domaine ; unités techniques.
      '(?:verifying|issues|leading|trailing|lower|bad|analyzing|fixing|verbatim|ExportRequestError|__pack__)',
      '(?:dBTP|LUFS|kHz|Hz|s|320×240|×)', '\\\\u0000', '&(?:amp|lt|gt|quot|#39);', '[-#`]+', '```text',
      // Marqueurs du format de nom communautaire (N+], _(bonus), [by_, _Vn) : donnée écrite.
      '(?:_\\(|\\)|\\+\\]|_V|\\[by_)'] },
  }],
} };
// Réglages : identifiants fermés et chemins techniques, sans exemption de prose.
const settingsLiteralConfig = { ...mediaLiteralConfig, files: [
  "src/tabs/OptionsTab.jsx",
  "src/tabs/OptionsTab/AdvancedSection.jsx",
  "src/tabs/OptionsTab/AiImagesSection.jsx",
  "src/tabs/OptionsTab/DiagnosticSection.jsx",
  "src/tabs/OptionsTab/InterfaceSection.jsx",
  "src/tabs/OptionsTab/OptionsSectionNav.jsx",
  "src/tabs/OptionsTab/PiperVoiceSettings.jsx",
  "src/tabs/OptionsTab/ProjectsMediaSection.jsx",
  "src/tabs/OptionsTab/SaveSection.jsx",
  "src/tabs/OptionsTab/VoiceSection.jsx",
  "src/tabs/OptionsTab/XttsVoiceSettings.jsx",
  "src/tabs/OptionsTab/YoutubeSection.jsx",
  "src/tabs/OptionsTab/useOptionsSectionNav.js",
  "src/tabs/OptionsTab/usePiperVoiceOptions.js",
  "src/tabs/OptionsTab/useXttsVoiceOptions.js",
  "src/workspace/SettingsPanel.jsx",
  "src/workspace/SettingsPanelHeader.jsx",
  "src/hooks/useAppPreferences.js",
  "src/store/loggingPreference.js",
  "src/store/persistentSettings.js",
  "src/store/sdSettings.js",
  "src/store/themePreference.js",
  "src/store/xttsSettings.js"
], rules: {
  'i18next/no-literal-string': ['error', { ...mediaLiteralConfig.rules['i18next/no-literal-string'][1],
    words: { exclude: [...mediaLiteralConfig.rules['i18next/no-literal-string'][1].words.exclude, 'settings:.*', 'ai:.*', 'launcherPath', 'label', 'opts-card.*',
      '(?:piper|xtts|cuda|cpu|global|local_prompt|local_sequence|simple|pack|multi|root|moon|stop|end-node|save|interface|projects-media|comfyui|advanced|youtube|diagnostic|warn|ok|idle|loading|error|fr_FR|en_GB|en_US|it_IT|fr|en|es|de|it|pt|system|dark|light|info|1|0|NFC|start|smooth)',
      '(?:fr_FR-siwis-medium|fr_FR-gilles-low|en_GB-jenny_dioco-medium|en_US-kristin-medium|it_IT-serena-medium|http://127\\.0\\.0\\.1:[0-9]+|\\(prefers-color-scheme: dark\\)|GPU CUDA|CPU|×|, | • )'] },
  }],
} };
const helpLiteralConfig = { files: ['src/components/common/CreditsModal.jsx', 'src/components/common/HelpHint.jsx', 'src/components/StorySettingsModal/KeyboardShortcutsModal.jsx', 'src/store/keyboardShortcuts.js'], plugins: { i18next }, rules: {
  'i18next/no-literal-string': ['error', { ...literalRule[1],
    callees: { exclude: [...literalRule[1].callees.exclude, 'translateHelp'] },
    words: { exclude: [...literalRule[1].words.exclude, 'help:.*', '[?✕]', '(?:Armand|hugs11|marian-m12l|Jersou|Dantsu|o\\.Daneel|LuckyTheCookie|STUdio|Lunii\\.QT)', '(?:libre|graph|audioEditor|imageEditor|general|selection|mediaPanel|a11y|KeyN|KeyO|KeyP|KeyS|KeyG|KeyF|KeyE|KeyZ|KeyC|KeyX|KeyV|KeyD|KeyI|KeyR|KeyA|KeyM|KeyJ|KeyK|KeyL|Digit[0-9]|Numpad[0-9]|NumpadAdd|NumpadSubtract|Equal|Minus|Comma|Period|Semicolon|Slash|Backslash|Quote|BracketLeft|BracketRight|Enter|Space|Escape|Click|Drag|Shift|Alt|Meta|Control|Dead|Unidentified|Tab|Delete|Backspace|PageUp|PageDown|F2|audio|image|scope|keyup|label|Numpad|Key|Digit|Home|End|Page↑|Page↓)', 'is-capturing', '(?:tabEdit|tabDiagram)',
      // Symboles des touches et ponctuation : conventions clavier techniques, sans prose.
      "(?:,|;|'|=|\u2190|\u2191|\u2193|\u232b)", "\\[", "\\]"] },
  }],
} };
// Lot 4.12 — exemples du graphe. Exceptions fermées : clés `examples:`/`ai:`/`common:`,
// identifiants de voix et commandes Piper, statuts et rôles internes ; aucune prose.
const examplesLiteralConfig = { files: ['src/components/AdvancedWorkspace/ExampleDialog.jsx', 'src/components/AdvancedWorkspace/ExamplesMenu.jsx', 'src/hooks/useAdvancedExamples.js', 'src/store/advancedExamples/catalog.js', 'src/store/advancedExamples/exampleBuilder.js', 'src/store/advancedExamples/media.js', 'src/store/advancedExamples/quizExamples.js', 'src/store/advancedExamples/storyExamples.js', 'src/store/advancedExamples/trainExample.js', 'src/store/advancedExamples/transaction.js'], plugins: { i18next }, rules: {
  'i18next/no-literal-string': ['error', { ...literalRule[1],
    'jsx-attributes': { exclude: [...literalRule[1]['jsx-attributes'].exclude, 'aria-pressed'] },
    'object-properties': { exclude: [...literalRule[1]['object-properties'].exclude, 'status', 'backend', 'target', 'gesture', 'code'] },
    callees: { exclude: [...literalRule[1].callees.exclude, 'tx', 'builder.tx', 'failure', 'translateExamples', 'aiRef', 'remove', 'ensure', 'Object.defineProperty'] },
    words: { exclude: [...literalRule[1].words.exclude, 'examples:.*', 'ai:.*', 'graph:.*',
      // Identifiants de voix du catalogue Piper, commandes IPC, moteurs et états internes.
      '(?:fr_FR-siwis-medium|en_US-kristin-medium|it_IT-serena-medium|piper_list_voices|piper_ensure_voice|piper|xtts|ready|checking|missing|unavailable|choice|narration|entry|applied|advancedStage|image|audio|garden-quiz|castle-quiz|grey-rabbit|lighthouse|explorer-train|EXAMPLE_POSITION_UNAVAILABLE|node\\.defaultStageName|creation\\.pack\\.defaultName|\\{\\{number\\}\\}|pseudo|en|it|userMessage)',
      // Gabarits techniques de noms de fichiers et motifs de forme.
      'exemple-', '\\.png'] },
  }],
} };
export default [examplesLiteralConfig, helpLiteralConfig, settingsLiteralConfig, checkerLiteralConfig, productionLiteralConfig, aiLiteralConfig, ...config, graphLiteralConfig, importLiteralConfig, mediaLiteralConfig, {
  files: ['src/store/generatedNavigation.js'],
  plugins: { i18next },
  rules: { 'i18next/no-literal-string': ['error', {
    ...literalRule[1], words: { exclude: [...literalRule[1].words.exclude,
      // Présentation legacy exportée pour les tests, sans consommateur dans src/ ; hors exception autorisée.
      'Retour vers «.*', '»', 'Retour à la couverture du pack', 'Racine', 'Histoire suivante',
      "Histoire suivante selon l'histoire source", 'Retour de fin -.*', 'Lecture directe -.*', 'destination introuvable',
    ] },
  }] },
}];
