import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';
import { PUBLIC_LANGUAGES } from '../src/i18n/language.js';

// Lot 4.3b : ZIP = format ; deux modèles aria ne contiennent que paramètres et ponctuation.
// Codes de présence/transition, occurrence technique et séparateurs de compte : neutres.
// Formes neutres nominatives : bouton physique OK, templates ne contenant que données/ponctuation,
// et mots identiques dans les langues cibles (image, audio, position, occurrence, images).
// Aides : modèle de ponctuation et mots identiques nominatifs.
export const HELP_NEUTRAL_KEYS = { en: new Set(['keyboard.tooltip.withShortcut', 'credits.documentation.label', 'shortcut.audioShuttleStop.label']), it: new Set(['keyboard.tooltip.withShortcut', 'keyboard.key.click']) };
export const GRAPH_NEUTRAL_KEYS = new Set(["inspector.audio.label","inspector.image.label","inspector.transitions.label","inspector.position.label","surface.structure.label","inspector.identifier.occurrence","inspector.media.usageLabel","search.identifier.occurrence","exit.ok.label","remove.stage.references","remove.reference.row","remove.selection.row","selection.counts.list","selection.images.busy","stage.id.occurrence","stage.media.image","stage.layout.position","action.arrivals.caption","diagnostics.media.image","diagnostics.media.audio","diagnostics.opaque.member","diagnostics.opaque.occurrence","inspector.absent.label","inspector.null.label","inspector.home.label","search.summary.counts"]);
// Filtres natifs : termes identiques et nom officiel du workflow ComfyUI.
const HOME_NEUTRAL_KEYS = new Set(['modeSelector.documentation.label', 'aggregate.step.audio', 'aggregate.step.image', 'packName.description.annotation', 'packName.bonus.label', 'packName.version.label', 'packName.description.label']);
const IMPORT_NATIVE_NEUTRAL_KEYS = new Set(['native:file.image.filterLabel', 'native:file.audio.filterLabel', 'native:file.comfyApi.filterLabel', 'import:podcast.default.title', 'import:youtube.audio.step', 'import:youtube.url.placeholder', 'import:youtube.page.label', 'import:youtube.failure.known', 'import:format.value.supportedVersion', 'import:format.value.absent']);
const TREE_NEUTRAL_KEYS = new Set(["color.orange.label","diagram.focus.short","nodeType.zip", "display.option.aria", "context.disabled.aria","control.ok.short","root.image.badge","nativeGraph.counts.summary","nativeGraph.stage.name","endPlayback.mixed.summary", "media.image.label", "navigation.destination.label", "multi.image.progress", "media.native.audio", "media.native.image"]);
// Lot 4.13 : mots identiques dans une seule langue cible (IT « l’audio », EN « Pause », « OK »).
const TREE_LANGUAGE_NEUTRAL_KEYS = { en: new Set(["nativeGraph.control.pause", "nativeGraph.control.ok"]), it: new Set(["context.file.audio", "nativeGraph.control.ok"]) };
// Lot 4.5 : mots et gabarits identiques en EN/IT (termes techniques, marques,
// gabarits sans prose) ; liste nominative, pas d’exemption par motif.
const MEDIA_NEUTRAL_KEYS = new Set([
  'explorer.kind.image', 'explorer.kind.archive', 'explorer.column.usage', 'explorer.column.dimensions',
  'explorer.column.format', 'explorer.column.date', 'explorer.column.tags', 'explorer.tags.header',
  'explorer.tags.bulkHeader', 'explorer.filter.images', 'explorer.filter.audio', 'explorer.filter.zip',
  'explorer.filter.ai', 'popover.audio.pause', 'popover.image.size', 'tile.usage.line',
  'imageEditor.filter.saturation', 'imageEditor.levels.gamma', 'audioEditor.transport.stop',
  'audioEditor.zoom.label', 'assembly.options.title', 'splitter.source.label', 'splitter.destination.label',
  'record.preview.pause', 'relink.kind.audio', 'relink.kind.image', 'relink.kind.archive', 'relink.kind.media',
  'subscriptions.source.fallback', 'subscriptions.notifications.title',
  'usage.field.audio', 'usage.field.image', 'usage.label.homeStep',
]);
// Lot 4.12 — exemples : gabarits ne contenant que des paramètres et de la
// ponctuation (comptes déjà traduits). Liste nominative, aucune exemption par motif.
export const EXAMPLES_NEUTRAL_KEYS = { en: new Set(['menu.item.counts', 'dialog.result.media']), it: new Set(['menu.item.counts', 'dialog.result.media']) };
export const LANGUAGES = ['fr', 'en', 'it'];
const STATUSES = new Set(['ai', 'ai-reviewed', 'human', 'stale']);
const PLURAL = /_(zero|one|two|few|many|other)$/;
// Familles fermées : toute nouvelle famille doit être déclarée ici.
export const DYNAMIC_FAMILIES = {
  'tree:nodeType.': ['root', 'menu', 'story', 'zip'],
  'rust:': [], // Alimentée par le registre Rust versionné obligatoire.
  'settings:interface.language.': ['french', 'english', 'italian', 'pseudo'],
  'settings:interface.theme.': ['system', 'dark', 'light'],
  'settings:navigation.': ['general', 'ai', 'advanced', 'save', 'projectsMedia', 'xtts', 'comfyui', 'silences', 'youtube', 'diagnostic'].map((key) => `${key}.label`),
};
export const AI_NEUTRAL_KEYS = {
  en: new Set(["image.workflow.label", "image.prompt.label", "image.prompt.placeholder", "image.negative.placeholder", "image.seed.label", "image.steps.label", "image.cfg.label", "image.lora.label", "queue.kind.image", "queue.kind.audio", "queue.column.type", "queue.column.target", "queue.column.usage", "queue.column.date", "voice.language.en"]),
  it: new Set(["image.workflow.label", "image.prompt.label", "image.prompt.placeholder", "image.negative.placeholder", "image.seed.label", "image.steps.label", "image.cfg.label", "image.lora.label", "queue.kind.audio", "queue.audio.name", "voice.language.it"])
};
// Lot 4.9 — vérificateur et rapports : mots identiques et corrects dans la langue
// cible (unités, marques, termes techniques, ponctuation sans prose). Clés de base,
// pluriels compris ; liste nominative, aucune exemption par motif.
export const CHECKER_NEUTRAL_KEYS = {
  en: new Set(["conform.audio.summary", "done.image.count", "file.role.audio", "file.role.image", "group.count.suggestions", "issue.badge.auto", "issue.badge.source", "measure.dimensions.label", "measure.format.label", "media.field.audio", "media.field.image", "metadata.uuid.label", "readiness.level.info", "readiness.source.fallback", "readiness.source.readiness", "report.footer.suggestions", "severity.info.label", "severity.ok.label", "summary.audio.title", "summary.images.title", "summary.split.ok", "summary.structure.title"]),
  it: new Set(["conform.audio.title", "conform.badge", "file.role.audio", "issue.badge.auto", "markdown.conform.audio", "measure.volume.label", "media.field.audio", "metadata.uuid.label", "severity.info.label", "severity.ok.label", "summary.audio.title", "summary.channels.notMono", "summary.split.ok"]),
};
const TABLE_CALLS = {
  "src/components/Catalogue/activity/CatalogueActivity.jsx:pill.label": ["catalogue:activity.pill.info"],
  "src/components/Catalogue/CatalogueFilterBar.jsx:key": ["catalogue:filter.favorites.only", "catalogue:palette.incomplete", "catalogue:filter.missingFiles.label"],
  "src/components/Catalogue/CatalogueFilterBar.jsx:FAMILY_CONTROLS.find(control => control.family === item.family)?.key ?? item.key": ["catalogue:filter.family.language", "catalogue:filter.family.format", "catalogue:filter.family.projectType", "catalogue:filter.family.source", "catalogue:filter.tags.label", "catalogue:filter.family.packState", "catalogue:filter.family.missing"],
  "src/components/Catalogue/CatalogueToolbar.jsx:item.key": ["catalogue:filter.favorites.only", "catalogue:palette.incomplete", "catalogue:filter.missingFiles.label", "catalogue:filter.tags.label", "catalogue:filter.family.format", "catalogue:filter.family.language"],
  "src/components/Catalogue/CatalogueViewControls.jsx:level.labelKey": ["catalogue:toolbar.density.compact", "catalogue:toolbar.density.normal", "catalogue:toolbar.density.large"],
  "src/components/Catalogue/CatalogueToolbar.jsx:criterion.key": ["catalogue:filter.family.language", "catalogue:filter.age.label", "catalogue:filter.favorites.only", "catalogue:filter.tags.label", "catalogue:filter.family.format", "catalogue:palette.incomplete", "catalogue:filter.missingFiles.label"],


  "src/components/Catalogue/fiche/LanguageSelect.jsx:key": ["catalogue:fiche.edit.language.fr", "catalogue:fiche.edit.language.en", "catalogue:fiche.edit.language.it", "catalogue:fiche.edit.language.de", "catalogue:fiche.edit.language.es", "catalogue:fiche.edit.language.pt", "catalogue:fiche.edit.language.nl", "catalogue:fiche.edit.language.ca", "catalogue:fiche.edit.language.eu", "catalogue:fiche.edit.language.br", "catalogue:fiche.edit.language.oc", "catalogue:fiche.edit.language.ar"],
  "src/store/catalogue/languageOptions.js:key": ["catalogue:fiche.edit.language.fr", "catalogue:fiche.edit.language.en", "catalogue:fiche.edit.language.it", "catalogue:fiche.edit.language.de", "catalogue:fiche.edit.language.es", "catalogue:fiche.edit.language.pt", "catalogue:fiche.edit.language.nl", "catalogue:fiche.edit.language.ca", "catalogue:fiche.edit.language.eu", "catalogue:fiche.edit.language.br", "catalogue:fiche.edit.language.oc", "catalogue:fiche.edit.language.ar"],
  "src/components/Catalogue/FavoriteButton.jsx:favorite ? 'catalogue:data.unfavorite' : 'catalogue:data.favorite'": ["catalogue:data.unfavorite", "catalogue:data.favorite"],
  "src/components/Catalogue/fiche/ExemplarTrashButton.jsx:availability.reasonKey": ["catalogue:actions.reason.noExemplar", "catalogue:trash.archiveShared", "catalogue:trash.archiveUnavailable", "catalogue:trash.archiveUnreadable", "catalogue:trash.archiveUninspectable", "catalogue:trash.archiveRefused"],
  "src/components/Catalogue/fiche/ExemplarOpenActions.jsx:command.reasonKey": ["catalogue:actions.reason.noExemplar", "catalogue:reason.action.fileUnavailable", "catalogue:reason.action.unsupportedFormat", "catalogue:reason.action.unreadable", "catalogue:reason.action.noSuitableExemplar", "catalogue:reason.action.archiveCorrupt", "catalogue:reason.action.archiveProtected", "catalogue:reason.action.encryptedUnknownKey", "catalogue:reason.action.invalidPack", "catalogue:reason.action.fileUnstable"],
  "src/components/Catalogue/fiche/SelectionPanel.jsx:favoriteState.labelKey": ["catalogue:selection.panel.unfavorite", "catalogue:selection.panel.favorite"],
  "src/store/catalogue/selectionPresentation.js:all ? 'catalogue:selection.panel.unfavorite' : 'catalogue:selection.panel.favorite'": ["catalogue:selection.panel.unfavorite", "catalogue:selection.panel.favorite"],
  "src/components/Catalogue/fiche/SelectionPanel.jsx:action.labelKey": ["catalogue:data.favorite", "catalogue:data.unfavorite", "catalogue:tags.title", "catalogue:assembly.title"],
  // Closed reasons of the collective favorite action (dataActions.js).
  "src/components/Catalogue/fiche/SelectionPanel.jsx:favorite.reasonKey": ["catalogue:data.busy", "catalogue:data.noTarget"],
  "src/components/Catalogue/fiche/SelectionPanel.jsx:action.reasonKey": ["catalogue:data.busy", "catalogue:data.noTarget", "catalogue:assembly.preparing"],
  "src/components/Catalogue/tags/TagInput.jsx:collision ? 'catalogue:tags.input.reuse' : 'catalogue:tags.input.add'": ["catalogue:tags.input.reuse", "catalogue:tags.input.add"],
  "src/components/Catalogue/tags/TagInput.jsx:busy ? 'catalogue:data.busy' : collision ? 'catalogue:tags.input.collision' : 'catalogue:tags.input.help'": ["catalogue:data.busy", "catalogue:tags.input.collision", "catalogue:tags.input.help"],
  "src/store/catalogue/dataActions.js:targets.length && targets.every(card => card.favorite) ? 'catalogue:data.unfavorite' : 'catalogue:data.favorite'": ["catalogue:data.favorite", "catalogue:data.unfavorite"],
  "src/components/Catalogue/fiche/FicheEditPanel.jsx:FIELD_LABELS[e.field]": ["catalogue:fiche.edit.field.title", "catalogue:fiche.edit.field.description", "catalogue:fiche.edit.field.versionDeclared", "catalogue:fiche.edit.field.cover", "catalogue:fiche.edit.field.ageMin", "catalogue:fiche.edit.field.ageMax", "catalogue:fiche.edit.field.language", "catalogue:fiche.edit.field.author", "catalogue:fiche.edit.field.producer", "catalogue:fiche.edit.field.bonus", "catalogue:fiche.edit.field.keywords", "catalogue:fiche.edit.field.durationSeconds", "catalogue:fiche.edit.field.storyCount"],
  "src/components/Catalogue/fiche/FicheEditPanel.jsx:saving ? 'catalogue:fiche.edit.busy' : invalid ? 'catalogue:fiche.edit.fixErrors' : dirty ? 'catalogue:fiche.edit.unsavedTitle' : 'catalogue:fiche.edit.saved'": ["catalogue:fiche.edit.busy", "catalogue:fiche.edit.fixErrors", "catalogue:fiche.edit.unsavedTitle", "catalogue:fiche.edit.saved"],
  "src/components/Catalogue/fiche/FieldEditor.jsx:field.labelKey": ["catalogue:fiche.edit.field.title", "catalogue:fiche.edit.field.description", "catalogue:fiche.edit.field.versionDeclared", "catalogue:fiche.edit.field.cover", "catalogue:fiche.edit.field.ageMin", "catalogue:fiche.edit.field.ageMax", "catalogue:fiche.edit.field.language", "catalogue:fiche.edit.field.author", "catalogue:fiche.edit.field.producer", "catalogue:fiche.edit.field.bonus", "catalogue:fiche.edit.field.keywords", "catalogue:fiche.edit.field.durationSeconds", "catalogue:fiche.edit.field.storyCount"],
  "src/components/Catalogue/fiche/FieldEditor.jsx:key": ["catalogue:fiche.edit.language.fr", "catalogue:fiche.edit.language.en", "catalogue:fiche.edit.language.it", "catalogue:fiche.edit.language.de", "catalogue:fiche.edit.language.es", "catalogue:fiche.edit.language.pt", "catalogue:fiche.edit.language.nl", "catalogue:fiche.edit.language.ca", "catalogue:fiche.edit.language.eu", "catalogue:fiche.edit.language.br", "catalogue:fiche.edit.language.oc", "catalogue:fiche.edit.language.ar"],
  "src/components/Catalogue/fiche/FieldEditor.jsx:error": ["catalogue:fiche.edit.invalid", "catalogue:fiche.edit.ageInterval"],
  "src/store/catalogue/cardModel.js:FIELD_LABELS[field.field]": ["catalogue:fiche.edit.field.title", "catalogue:fiche.edit.field.description", "catalogue:fiche.edit.field.versionDeclared", "catalogue:fiche.edit.field.cover", "catalogue:fiche.edit.field.ageMin", "catalogue:fiche.edit.field.ageMax", "catalogue:fiche.edit.field.language", "catalogue:fiche.edit.field.author", "catalogue:fiche.edit.field.producer", "catalogue:fiche.edit.field.bonus", "catalogue:fiche.edit.field.keywords", "catalogue:fiche.edit.field.durationSeconds", "catalogue:fiche.edit.field.storyCount"],
  "src/store/catalogue/compareExemplars.js:labelKey": ["catalogue:fiche.edit.field.title", "catalogue:fiche.edit.field.description", "catalogue:fiche.edit.field.versionDeclared", "catalogue:fiche.edit.field.cover", "catalogue:fiche.edit.field.ageMin", "catalogue:fiche.edit.field.ageMax", "catalogue:fiche.edit.field.language", "catalogue:fiche.edit.field.author", "catalogue:fiche.edit.field.producer", "catalogue:fiche.edit.field.bonus", "catalogue:fiche.edit.field.keywords", "catalogue:fiche.edit.field.durationSeconds", "catalogue:fiche.edit.field.storyCount"],


  "src/components/Catalogue/fiche/FicheEditPanel.jsx:field.field === 'ageMin' ? 'catalogue:fiche.inline.ageFrom' : 'catalogue:fiche.inline.ageTo'": ["catalogue:fiche.inline.ageFrom", "catalogue:fiche.inline.ageTo"],
  "src/components/Catalogue/open/CatalogueSimulator.jsx:row.formatKey": ["catalogue:format.project.label", "catalogue:format.zip.label", "catalogue:format.sevenZip.label", "catalogue:format.folder.label"],
  "src/components/Catalogue/open/CompactExemplar.jsx:row.formatKey": ["catalogue:format.project.label", "catalogue:format.zip.label", "catalogue:format.sevenZip.label", "catalogue:format.folder.label"],
  "src/components/Catalogue/open/ExemplarChoiceDialog.jsx:item.reasonKey": ["catalogue:actions.reason.noExemplar", "catalogue:reason.action.fileUnavailable", "catalogue:reason.action.archiveCorrupt", "catalogue:reason.action.archiveProtected", "catalogue:reason.action.invalidPack", "catalogue:reason.action.unsupportedFormat", "catalogue:reason.action.fileUnstable", "catalogue:reason.action.unreadable", "catalogue:reason.action.noSuitableExemplar"],
  "src/components/Catalogue/open/ExemplarChoiceDialog.jsx:texts.title": ["catalogue:open.choice.simulate.title", "catalogue:open.choice.edit.title"],
  'src/store/catalogue/emptyState.js:empty.key': ['catalogue:empty.noSources.message','catalogue:empty.loading.message','catalogue:empty.initialScan.message','catalogue:empty.offline.message','catalogue:empty.filtered.message','catalogue:empty.noPacks.message'],
  'src/components/Catalogue/CatalogueEmptyState.jsx:empty.actionKey': ['catalogue:sources.add.label','catalogue:preferences.link.label','catalogue:empty.filtered.action'],
  'src/components/Catalogue/CatalogueFilterBar.jsx:FILTER_VALUE_KEYS[value]': ['catalogue:format.project.label','catalogue:format.zip.label','catalogue:format.sevenZip.label','catalogue:format.folder.label','catalogue:filter.type.simple','catalogue:filter.type.menus','catalogue:filter.type.graph','catalogue:filter.missing.title','catalogue:filter.missing.age','catalogue:filter.missing.cover','catalogue:generation.modified.reason'],
  'src/components/Catalogue/CatalogueFilterBar.jsx:control.key': ['catalogue:filter.family.language','catalogue:filter.family.format','catalogue:filter.family.projectType','catalogue:filter.family.source','catalogue:filter.tags.label','catalogue:filter.family.packState','catalogue:filter.family.missing'],

  "src/components/Catalogue/CatalogueToolbar.jsx:SORT_LABELS[key]": ["catalogue:toolbar.count.fiches", "catalogue:toolbar.label", "catalogue:toolbar.search.clear", "catalogue:toolbar.search.label", "catalogue:toolbar.search.placeholder", "catalogue:toolbar.sort.addedAt", "catalogue:toolbar.sort.age", "catalogue:toolbar.sort.ascending", "catalogue:toolbar.sort.descending", "catalogue:toolbar.sort.duration", "catalogue:toolbar.sort.format", "catalogue:toolbar.sort.label", "catalogue:toolbar.sort.modifiedAt", "catalogue:toolbar.sort.size", "catalogue:toolbar.sort.title", "catalogue:toolbar.view.cards", "catalogue:toolbar.view.label", "catalogue:toolbar.view.list"],
  "src/components/Catalogue/CatalogueToolbar.jsx:view.sort.direction === 'asc' ? 'catalogue:toolbar.sort.ascending' : 'catalogue:toolbar.sort.descending'": ["catalogue:toolbar.count.fiches", "catalogue:toolbar.label", "catalogue:toolbar.search.clear", "catalogue:toolbar.search.label", "catalogue:toolbar.search.placeholder", "catalogue:toolbar.sort.addedAt", "catalogue:toolbar.sort.age", "catalogue:toolbar.sort.ascending", "catalogue:toolbar.sort.descending", "catalogue:toolbar.sort.duration", "catalogue:toolbar.sort.format", "catalogue:toolbar.sort.label", "catalogue:toolbar.sort.modifiedAt", "catalogue:toolbar.sort.size", "catalogue:toolbar.sort.title", "catalogue:toolbar.view.cards", "catalogue:toolbar.view.label", "catalogue:toolbar.view.list"],
  "src/components/Catalogue/activity/CatalogueActivity.jsx:GROUP_LABELS[group]": ["catalogue:activity.group.issue", "catalogue:activity.group.progress", "catalogue:activity.group.info"],
  "src/components/Catalogue/CatalogueViewControls.jsx:mode.labelKey": ["catalogue:toolbar.count.fiches", "catalogue:toolbar.label", "catalogue:toolbar.search.clear", "catalogue:toolbar.search.label", "catalogue:toolbar.search.placeholder", "catalogue:toolbar.sort.addedAt", "catalogue:toolbar.sort.age", "catalogue:toolbar.sort.ascending", "catalogue:toolbar.sort.descending", "catalogue:toolbar.sort.duration", "catalogue:toolbar.sort.format", "catalogue:toolbar.sort.label", "catalogue:toolbar.sort.modifiedAt", "catalogue:toolbar.sort.size", "catalogue:toolbar.sort.title", "catalogue:toolbar.view.cards", "catalogue:toolbar.view.label", "catalogue:toolbar.view.list"],
  "src/components/Catalogue/FormatTag.jsx:tag.labelKey": ["catalogue:details.column.formats", "catalogue:exemplar.state.available", "catalogue:exemplar.state.missing", "catalogue:exemplar.state.unavailable", "catalogue:format.folder.label", "catalogue:format.project.label", "catalogue:format.sevenZip.label", "catalogue:format.zip.label", "catalogue:formatTag.count", "catalogue:formatTag.inArchive", "catalogue:formatTag.inspect", "catalogue:formatTag.unavailable", "catalogue:reason.accessDenied", "catalogue:reason.cancelled", "catalogue:reason.corruptArchive", "catalogue:reason.depthLimitExceeded", "catalogue:reason.excludedByRule", "catalogue:reason.fileDisappeared", "catalogue:reason.fileUnstable", "catalogue:reason.invalidStructure", "catalogue:reason.itemLimitExceeded", "catalogue:reason.operationFailed", "catalogue:reason.overlappingSource", "catalogue:reason.protectedArchive", "catalogue:reason.readLimitExceeded", "catalogue:reason.scanSuperseded", "catalogue:reason.technicalExclusion", "catalogue:reason.unreadableUnknown", "catalogue:reason.unsupportedFormat", "catalogue:reason.volumeUnavailable"],
  "src/components/Catalogue/menus/CardContextMenu.jsx:CHOICE_TITLES[menu.step.action] ?? 'catalogue:menu.card.label'": ["catalogue:card.untitled", "catalogue:exemplar.state.available", "catalogue:exemplar.state.missing", "catalogue:exemplar.state.unavailable", "catalogue:format.folder.label", "catalogue:format.project.label", "catalogue:format.sevenZip.label", "catalogue:format.zip.label", "catalogue:menu.card.label", "catalogue:menu.choose.reveal", "catalogue:reason.accessDenied", "catalogue:reason.cancelled", "catalogue:reason.corruptArchive", "catalogue:reason.depthLimitExceeded", "catalogue:reason.excludedByRule", "catalogue:reason.fileDisappeared", "catalogue:reason.fileUnstable", "catalogue:reason.invalidStructure", "catalogue:reason.itemLimitExceeded", "catalogue:reason.operationFailed", "catalogue:reason.overlappingSource", "catalogue:reason.protectedArchive", "catalogue:reason.readLimitExceeded", "catalogue:reason.scanSuperseded", "catalogue:reason.technicalExclusion", "catalogue:reason.unreadableUnknown", "catalogue:reason.unsupportedFormat", "catalogue:reason.volumeUnavailable"],
  "src/components/Catalogue/menus/CardContextMenu.jsx:row.formatKey": ["catalogue:card.untitled", "catalogue:exemplar.state.available", "catalogue:exemplar.state.missing", "catalogue:exemplar.state.unavailable", "catalogue:format.folder.label", "catalogue:format.project.label", "catalogue:format.sevenZip.label", "catalogue:format.zip.label", "catalogue:menu.card.label", "catalogue:menu.choose.reveal", "catalogue:reason.accessDenied", "catalogue:reason.cancelled", "catalogue:reason.corruptArchive", "catalogue:reason.depthLimitExceeded", "catalogue:reason.excludedByRule", "catalogue:reason.fileDisappeared", "catalogue:reason.fileUnstable", "catalogue:reason.invalidStructure", "catalogue:reason.itemLimitExceeded", "catalogue:reason.operationFailed", "catalogue:reason.overlappingSource", "catalogue:reason.protectedArchive", "catalogue:reason.readLimitExceeded", "catalogue:reason.scanSuperseded", "catalogue:reason.technicalExclusion", "catalogue:reason.unreadableUnknown", "catalogue:reason.unsupportedFormat", "catalogue:reason.volumeUnavailable"],
  "src/components/Catalogue/menus/CatalogueMenu.jsx:action.labelKey": ["catalogue:actions.simulate.choose", "catalogue:reason.action.fileUnavailable", "catalogue:reason.action.archiveCorrupt", "catalogue:reason.action.archiveProtected", "catalogue:reason.action.invalidPack", "catalogue:reason.action.unsupportedFormat", "catalogue:reason.action.fileUnstable", "catalogue:reason.action.unreadable", "catalogue:reason.action.noSuitableExemplar", "catalogue:actions.copyTitle.label", "catalogue:actions.copyUuid.label", "catalogue:actions.edit.label", "catalogue:actions.editPack.label", "catalogue:actions.openAndGenerate.label", "catalogue:actions.openFiche.label", "catalogue:actions.openProject.label", "catalogue:actions.reason.noExemplar", "catalogue:actions.reason.noPath", "catalogue:actions.reason.noTitle", "catalogue:actions.reason.noUuid", "catalogue:actions.reason.severalUuids", "catalogue:actions.reveal.archiveHint", "catalogue:actions.reveal.choose", "catalogue:actions.reveal.done", "catalogue:actions.reveal.fallback", "catalogue:actions.reveal.label", "catalogue:actions.simulate.label", "catalogue:menu.back.label"],
  "src/components/Catalogue/menus/CatalogueMenu.jsx:action.reasonKey": ["catalogue:trash.archiveShared", "catalogue:trash.archiveUnavailable", "catalogue:trash.archiveUnreadable", "catalogue:trash.archiveUninspectable", "catalogue:trash.archiveRefused", "catalogue:actions.simulate.choose", "catalogue:reason.action.fileUnavailable", "catalogue:reason.action.archiveCorrupt", "catalogue:reason.action.archiveProtected", "catalogue:reason.action.invalidPack", "catalogue:reason.action.unsupportedFormat", "catalogue:reason.action.fileUnstable", "catalogue:reason.action.unreadable", "catalogue:reason.action.noSuitableExemplar", "catalogue:actions.copyTitle.label", "catalogue:actions.copyUuid.label", "catalogue:actions.edit.label", "catalogue:actions.editPack.label", "catalogue:actions.openAndGenerate.label", "catalogue:actions.openFiche.label", "catalogue:actions.openProject.label", "catalogue:actions.reason.noExemplar", "catalogue:actions.reason.noPath", "catalogue:actions.reason.noTitle", "catalogue:actions.reason.noUuid", "catalogue:actions.reason.severalUuids", "catalogue:actions.reveal.archiveHint", "catalogue:actions.reveal.choose", "catalogue:actions.reveal.done", "catalogue:actions.reveal.fallback", "catalogue:actions.reveal.label", "catalogue:actions.simulate.label", "catalogue:menu.back.label"],
  "src/components/Catalogue/views/EditButton.jsx:state.reasonKey": ["catalogue:actions.copyTitle.label", "catalogue:actions.copyUuid.label", "catalogue:actions.edit.label", "catalogue:actions.editPack.label", "catalogue:actions.openAndGenerate.label", "catalogue:actions.openFiche.label", "catalogue:actions.openProject.label", "catalogue:actions.reason.noExemplar", "catalogue:actions.reveal.archiveHint", "catalogue:actions.reveal.choose", "catalogue:actions.reveal.done", "catalogue:actions.reveal.fallback", "catalogue:actions.reveal.label", "catalogue:actions.simulate.label", "catalogue:menu.back.label"],
  "src/components/Catalogue/views/ExemplarTable.jsx:full ? 'catalogue:exemplar.column.path' : 'catalogue:exemplar.column.folder'": ["catalogue:card.untitled", "catalogue:details.column.modifiedAt", "catalogue:details.column.version", "catalogue:exemplar.column.actions", "catalogue:exemplar.column.folder", "catalogue:exemplar.column.format", "catalogue:exemplar.column.name", "catalogue:exemplar.column.path", "catalogue:exemplar.column.size", "catalogue:exemplar.column.state", "catalogue:exemplar.table.caption"],
  "src/components/Catalogue/views/RowTable.jsx:labelKey": ["catalogue:details.age.exact", "catalogue:details.age.from", "catalogue:details.age.invalid", "catalogue:details.age.range", "catalogue:details.age.upTo", "catalogue:details.column.age", "catalogue:details.column.author", "catalogue:details.column.cover", "catalogue:details.column.duration", "catalogue:details.column.formats", "catalogue:details.column.language", "catalogue:details.column.modifiedAt", "catalogue:details.column.stories", "catalogue:details.column.summary", "catalogue:details.column.title", "catalogue:details.column.version", "catalogue:details.duration.minutes", "catalogue:details.stories.count", "catalogue:details.value.notProvided", "catalogue:details.version.value", "catalogue:exemplar.column.actions", "catalogue:exemplar.location.inArchive", "catalogue:exemplar.state.available", "catalogue:toolbar.sort.addedAt", "catalogue:toolbar.sort.age", "catalogue:toolbar.sort.duration", "catalogue:toolbar.sort.modifiedAt", "catalogue:toolbar.sort.size", "catalogue:toolbar.sort.title", "catalogue:toolbar.view.cards", "catalogue:toolbar.view.list"],
  "src/components/Catalogue/ColumnPicker.jsx:column.labelKey": ["catalogue:details.column.cover", "catalogue:details.column.title", "catalogue:details.column.age", "catalogue:details.column.duration", "catalogue:details.column.formats", "catalogue:tags.title", "catalogue:details.column.summary", "catalogue:details.column.language", "catalogue:details.column.stories", "catalogue:details.column.author", "catalogue:details.column.version", "catalogue:details.column.modifiedAt"],
  "src/components/Catalogue/views/RowTable.jsx:column.labelKey": ["catalogue:details.age.exact", "catalogue:details.age.from", "catalogue:details.age.invalid", "catalogue:details.age.range", "catalogue:details.age.upTo", "catalogue:tags.title", "catalogue:details.column.age", "catalogue:details.column.author", "catalogue:details.column.cover", "catalogue:details.column.duration", "catalogue:details.column.formats", "catalogue:details.column.language", "catalogue:details.column.modifiedAt", "catalogue:details.column.stories", "catalogue:details.column.summary", "catalogue:details.column.title", "catalogue:details.column.version", "catalogue:details.duration.minutes", "catalogue:details.stories.count", "catalogue:details.value.notProvided", "catalogue:details.version.value", "catalogue:exemplar.column.actions", "catalogue:exemplar.location.inArchive", "catalogue:exemplar.state.available", "catalogue:toolbar.sort.addedAt", "catalogue:toolbar.sort.age", "catalogue:toolbar.sort.duration", "catalogue:toolbar.sort.modifiedAt", "catalogue:toolbar.sort.size", "catalogue:toolbar.sort.title", "catalogue:toolbar.view.cards", "catalogue:toolbar.view.list"],
  "src/store/catalogue/cardActions.js:labelKey = LABELS[id]": ["catalogue:actions.copyTitle.label", "catalogue:actions.copyUuid.label", "catalogue:actions.edit.label", "catalogue:actions.editPack.label", "catalogue:actions.openAndGenerate.label", "catalogue:actions.openFiche.label", "catalogue:actions.openProject.label", "catalogue:actions.reason.noExemplar", "catalogue:actions.reveal.archiveHint", "catalogue:actions.reveal.choose", "catalogue:actions.reveal.done", "catalogue:actions.reveal.fallback", "catalogue:actions.reveal.label", "catalogue:actions.simulate.label", "catalogue:menu.back.label"],
  "src/store/catalogue/cardActions.js:labelKey": ["catalogue:actions.copyTitle.label", "catalogue:actions.copyUuid.label", "catalogue:actions.edit.label", "catalogue:actions.editPack.label", "catalogue:actions.openAndGenerate.label", "catalogue:actions.openFiche.label", "catalogue:actions.openProject.label", "catalogue:actions.reason.noExemplar", "catalogue:actions.reveal.archiveHint", "catalogue:actions.reveal.choose", "catalogue:actions.reveal.done", "catalogue:actions.reveal.fallback", "catalogue:actions.reveal.label", "catalogue:actions.simulate.label", "catalogue:menu.back.label"],
  "src/store/catalogue/cardActions.js:CHOICE_LABELS[id]": ["catalogue:actions.copyTitle.label", "catalogue:actions.copyUuid.label", "catalogue:actions.edit.label", "catalogue:actions.editPack.label", "catalogue:actions.openAndGenerate.label", "catalogue:actions.openFiche.label", "catalogue:actions.openProject.label", "catalogue:actions.reason.noExemplar", "catalogue:actions.reveal.archiveHint", "catalogue:actions.reveal.choose", "catalogue:actions.reveal.done", "catalogue:actions.reveal.fallback", "catalogue:actions.reveal.label", "catalogue:actions.simulate.label", "catalogue:menu.back.label"],
  "src/store/catalogue/formatTag.js:formatLabelKey(format)": ["catalogue:exemplar.state.available", "catalogue:exemplar.state.missing", "catalogue:exemplar.state.unavailable", "catalogue:format.folder.label", "catalogue:format.project.label", "catalogue:format.sevenZip.label", "catalogue:format.zip.label", "catalogue:formatTag.count", "catalogue:formatTag.inArchive", "catalogue:formatTag.inspect", "catalogue:formatTag.unavailable", "catalogue:reason.accessDenied", "catalogue:reason.cancelled", "catalogue:reason.corruptArchive", "catalogue:reason.depthLimitExceeded", "catalogue:reason.excludedByRule", "catalogue:reason.fileDisappeared", "catalogue:reason.fileUnstable", "catalogue:reason.invalidStructure", "catalogue:reason.itemLimitExceeded", "catalogue:reason.operationFailed", "catalogue:reason.overlappingSource", "catalogue:reason.protectedArchive", "catalogue:reason.readLimitExceeded", "catalogue:reason.scanSuperseded", "catalogue:reason.technicalExclusion", "catalogue:reason.unreadableUnknown", "catalogue:reason.unsupportedFormat", "catalogue:reason.volumeUnavailable"],
// Catalogue: closed tables and explicit alternatives, checked key by key.
"src/components/Catalogue/CatalogueScreen.jsx:EMPTY_KEYS[state]": ["catalogue:empty.noSources.message", "catalogue:empty.loading.message", "catalogue:empty.initialScan.message", "catalogue:empty.offline.message", "catalogue:empty.filtered.message", "catalogue:empty.noPacks.message", "catalogue:empty.noPacks.message"],
"src/components/Catalogue/CatalogueScreen.jsx:sources.loading || !operations.ready ? 'catalogue:screen.refresh.wait' : sources.busy ? 'catalogue:sources.busy.message' : 'catalogue:screen.refresh.noSources'": ["catalogue:screen.refresh.wait", "catalogue:sources.busy.message", "catalogue:screen.refresh.noSources"],
"src/components/Catalogue/operations/ScanSummary.jsx:reason.reasonKey": ["catalogue:reason.unsupportedFormat", "catalogue:reason.invalidStructure", "catalogue:reason.corruptArchive", "catalogue:reason.protectedArchive", "catalogue:reason.accessDenied", "catalogue:reason.fileDisappeared", "catalogue:reason.volumeUnavailable", "catalogue:reason.readLimitExceeded", "catalogue:reason.unreadableUnknown", "catalogue:reason.technicalExclusion", "catalogue:reason.overlappingSource", "catalogue:reason.fileUnstable", "catalogue:reason.itemLimitExceeded", "catalogue:reason.depthLimitExceeded", "catalogue:reason.excludedByRule", "catalogue:reason.scanSuperseded", "catalogue:reason.operationFailed", "catalogue:reason.cancelled"],
"src/components/Catalogue/sources/AddSourceControl.jsx:notice": ["catalogue:sources.duplicate.message", "catalogue:sources.folderOnly.message"],
"src/components/Catalogue/sources/SourceRow.jsx:STATUS[source.lastScanStatus] ?? 'catalogue:sources.state.unknown'": ["catalogue:sources.state.unknown", "catalogue:summary.result.success", "catalogue:summary.result.partial", "catalogue:summary.result.failed", "catalogue:summary.result.cancelled"],

"src/components/StorySettingsModal/KeyboardShortcutsModal.jsx:definition.labelKey": ["help:shortcut.newProject.label", "help:shortcut.openProject.label", "help:shortcut.openPack.label", "help:shortcut.saveProject.label", "help:shortcut.saveAs.label", "help:shortcut.tabOptions.label", "help:shortcut.generate.label", "help:shortcut.treeSearch.label", "help:shortcut.toggleValidation.label", "help:shortcut.undo.label", "help:shortcut.redo.label", "help:shortcut.selectionCopy.label", "help:shortcut.selectionCut.label", "help:shortcut.selectionPaste.label", "help:shortcut.selectionDuplicate.label", "help:shortcut.selectionDelete.label", "help:shortcut.selectionRename.label", "help:shortcut.importStories.label", "help:shortcut.addFolder.label", "help:shortcut.toggleTree.label", "help:shortcut.toggleSettings.label", "help:shortcut.toggleDiagram.label", "help:shortcut.graphZoomIn.label", "help:shortcut.graphZoomOut.label", "help:shortcut.graphFit.label", "help:shortcut.graphVisitBack.label", "help:shortcut.graphVisitForward.label", "help:shortcut.graphCreateStage.label", "help:shortcut.graphCreateAction.label", "help:shortcut.graphToggleOverview.label", "help:shortcut.graphArrange.label", "help:shortcut.graphBoxSelect.label", "help:shortcut.mediaSearch.label", "help:shortcut.audioPlayPause.label", "help:shortcut.audioShuttleBack.label", "help:shortcut.audioShuttleStop.label", "help:shortcut.audioShuttleFwd.label", "help:shortcut.audioNudgeBack.label", "help:shortcut.audioNudgeFwd.label", "help:shortcut.audioGoStart.label", "help:shortcut.audioGoEnd.label", "help:shortcut.audioMarkIn.label", "help:shortcut.audioMarkOut.label", "help:shortcut.audioClearIn.label", "help:shortcut.audioClearOut.label", "help:shortcut.audioPreviewIn.label", "help:shortcut.audioPreviewOut.label", "help:shortcut.audioKeepSelection.label", "help:shortcut.audioCutSelection.label", "help:shortcut.audioUndo.label", "help:shortcut.audioZoomIn.label", "help:shortcut.audioZoomOut.label", "help:shortcut.audioClose.label", "help:shortcut.imageClose.label", "help:shortcut.a11yNextItem.label", "help:shortcut.a11yPrevItem.label", "help:shortcut.a11yFirstItem.label", "help:shortcut.a11yLastItem.label", "help:shortcut.a11yActivate.label", "help:shortcut.a11yClose.label", "help:shortcut.a11yMultiSelect.label", "help:shortcut.a11yToggleSelect.label"],
"src/components/StorySettingsModal/KeyboardShortcutsModal.jsx:scope.labelKey": ["help:scope.catalogue.label", "help:scope.general.label", "help:scope.selection.label", "help:scope.libre.label", "help:scope.graph.label", "help:scope.mediaPanel.label", "help:scope.audioEditor.label", "help:scope.imageEditor.label", "help:scope.a11y.label"],
"src/components/StorySettingsModal/KeyboardShortcutsModal.jsx:scope.descriptionKey": ["help:scope.catalogue.description", "help:scope.general.description", "help:scope.selection.description", "help:scope.libre.description", "help:scope.graph.description", "help:scope.mediaPanel.description", "help:scope.audioEditor.description", "help:scope.imageEditor.description", "help:scope.a11y.description"],
"src/components/StorySettingsModal/KeyboardShortcutsModal.jsx:definition.readOnlyReasonKey": ["help:shortcut.graphBoxSelect.readOnlyReason", "help:shortcut.audioClose.readOnlyReason", "help:shortcut.imageClose.readOnlyReason", "help:shortcut.a11yNextItem.readOnlyReason", "help:shortcut.a11yPrevItem.readOnlyReason", "help:shortcut.a11yFirstItem.readOnlyReason", "help:shortcut.a11yLastItem.readOnlyReason", "help:shortcut.a11yActivate.readOnlyReason", "help:shortcut.a11yClose.readOnlyReason", "help:shortcut.a11yMultiSelect.readOnlyReason", "help:shortcut.a11yToggleSelect.readOnlyReason"],
"src/components/StorySettingsModal/KeyboardShortcutsModal.jsx:message.actionKey": ["help:shortcut.catalogueSearch.label", "help:shortcut.catalogueSelectAll.label", "help:shortcut.catalogueClearSelection.label", "help:shortcut.newProject.label", "help:shortcut.openProject.label", "help:shortcut.openPack.label", "help:shortcut.saveProject.label", "help:shortcut.saveAs.label", "help:shortcut.tabOptions.label", "help:shortcut.generate.label", "help:shortcut.treeSearch.label", "help:shortcut.toggleValidation.label", "help:shortcut.undo.label", "help:shortcut.redo.label", "help:shortcut.selectionCopy.label", "help:shortcut.selectionCut.label", "help:shortcut.selectionPaste.label", "help:shortcut.selectionDuplicate.label", "help:shortcut.selectionDelete.label", "help:shortcut.selectionRename.label", "help:shortcut.importStories.label", "help:shortcut.addFolder.label", "help:shortcut.toggleTree.label", "help:shortcut.toggleSettings.label", "help:shortcut.toggleDiagram.label", "help:shortcut.graphZoomIn.label", "help:shortcut.graphZoomOut.label", "help:shortcut.graphFit.label", "help:shortcut.graphVisitBack.label", "help:shortcut.graphVisitForward.label", "help:shortcut.graphCreateStage.label", "help:shortcut.graphCreateAction.label", "help:shortcut.graphToggleOverview.label", "help:shortcut.graphArrange.label", "help:shortcut.graphBoxSelect.label", "help:shortcut.mediaSearch.label", "help:shortcut.audioPlayPause.label", "help:shortcut.audioShuttleBack.label", "help:shortcut.audioShuttleStop.label", "help:shortcut.audioShuttleFwd.label", "help:shortcut.audioNudgeBack.label", "help:shortcut.audioNudgeFwd.label", "help:shortcut.audioGoStart.label", "help:shortcut.audioGoEnd.label", "help:shortcut.audioMarkIn.label", "help:shortcut.audioMarkOut.label", "help:shortcut.audioClearIn.label", "help:shortcut.audioClearOut.label", "help:shortcut.audioPreviewIn.label", "help:shortcut.audioPreviewOut.label", "help:shortcut.audioKeepSelection.label", "help:shortcut.audioCutSelection.label", "help:shortcut.audioUndo.label", "help:shortcut.audioZoomIn.label", "help:shortcut.audioZoomOut.label", "help:shortcut.audioClose.label", "help:shortcut.imageClose.label", "help:shortcut.a11yNextItem.label", "help:shortcut.a11yPrevItem.label", "help:shortcut.a11yFirstItem.label", "help:shortcut.a11yLastItem.label", "help:shortcut.a11yActivate.label", "help:shortcut.a11yClose.label", "help:shortcut.a11yMultiSelect.label", "help:shortcut.a11yToggleSelect.label"],
"src/components/StorySettingsModal/KeyboardShortcutsModal.jsx:message.scopeKey": ["help:scope.catalogue.label", "help:scope.general.label", "help:scope.selection.label", "help:scope.libre.label", "help:scope.graph.label", "help:scope.mediaPanel.label", "help:scope.audioEditor.label", "help:scope.imageEditor.label", "help:scope.a11y.label"],

"src/components/Catalogue/operations/OperationIssues.jsx:reasonLabelKey(item.reason)": ["catalogue:reason.unsupportedFormat", "catalogue:reason.invalidStructure", "catalogue:reason.corruptArchive", "catalogue:reason.protectedArchive", "catalogue:reason.accessDenied", "catalogue:reason.fileDisappeared", "catalogue:reason.volumeUnavailable", "catalogue:reason.readLimitExceeded", "catalogue:reason.unreadableUnknown", "catalogue:reason.technicalExclusion", "catalogue:reason.overlappingSource", "catalogue:reason.fileUnstable", "catalogue:reason.itemLimitExceeded", "catalogue:reason.depthLimitExceeded", "catalogue:reason.excludedByRule", "catalogue:reason.scanSuperseded", "catalogue:reason.operationFailed", "catalogue:reason.cancelled"],
  "src/store/production/productionReport.js:key": ["production:report.status.idle", "production:report.status.pending", "production:report.status.running", "production:report.status.succeeded", "production:report.status.cancelled", "production:report.status.failed"],
  "src/store/production/productionReport.js:PROGRESS_IN_PROGRESS": ["production:report.progress.note"],
  "src/store/production/productionGates.js:blocking ? labels.blocking : labels.observing": ["production:report.gate.passed", "production:report.gate.clear", "production:report.gate.refused", "production:report.gate.wouldRefuse", "production:report.gate.notEvaluated", "production:report.gate.notObserved"],
  "src/store/production/advancedRenderWork.js:titleKey": ["production:native.title.decode", "production:native.title.preparation", "production:native.title.media", "production:native.title.collision", "production:native.title.oracle", "production:native.title.cancelled", "production:native.title.write", "production:native.title.interrupted", "production:work.export.title"],
  "src/store/production/advancedRenderWork.js:qualificationKey": ["production:native.qualification.integrity", "production:native.qualification.author", "production:native.qualification.identity", "production:native.qualification.readiness", "production:native.qualification.serialization"],

  'src/components/RenderQueuePanel/RenderQueuePanel.jsx:STATUS_LABEL[job.status]': ['production:queue.status.pending', 'production:queue.status.running', 'production:queue.status.done', 'production:queue.status.error', 'production:queue.status.canceled'],
  'src/components/production/ProductionReport.jsx:gates.note': ['production:report.gates.absent'],
  'src/components/production/ProductionReport.jsx:gates.notice': ['production:report.gates.observation'],

  "src/components/GenerateVoiceModal/GenerateVoiceModal.jsx:PIPER_LANGUAGE_KEYS[value]": ["ai:voice.language.fr", "ai:voice.language.enGB", "ai:voice.language.enUS", "ai:voice.language.it"],
"src/components/GenerateVoiceModal/GenerateVoiceModal.jsx:optionLabel": ["ai:voice.language.fr", "ai:voice.language.en", "ai:voice.language.es", "ai:voice.language.de", "ai:voice.language.it", "ai:voice.language.pt"],
"src/components/SDQueuePanel/SDQueuePanel.jsx:STATUS_LABEL[job.status]": ["ai:queue.status.pending","ai:queue.status.submitting","ai:queue.status.running","ai:queue.status.done","ai:queue.status.error"],
"src/components/SDQueuePanel/SDQueuePanel.jsx:col.labelKey": ["ai:queue.column.type","ai:queue.column.name","ai:queue.column.target","ai:queue.column.result","ai:queue.column.status","ai:queue.column.usage","ai:queue.column.date"],
"src/hooks/useAiJobUsage.js:words.usedKey": ["ai:usage.audio.count", "ai:usage.graphImage.count"],
"src/hooks/useAiJobUsage.js:AUDIO_FIELD_LABELS[field]": ["ai:usage.audio.root", "ai:usage.audio.end", "ai:usage.audio.selection", "ai:usage.audio.playback", "ai:usage.audio.after", "ai:usage.audio.sequence", "ai:usage.audio.home", "ai:usage.audio.cover"],

  'src/hooks/useImportSession.js:MENU_DEPTH_LIMIT_REACHED_REF': ['tree:depth.limit.reached'],
  "src/hooks/useMediaImport.js:source === 'youtube'\n            ? youtubeImportFailureRef(result, copy.allFailedRef)\n            : copy.allFailedRef": ['import:podcast.import.failure', 'import:youtube.import.failure', 'import:youtube.failure.known'],
  'src/hooks/useMediaImport.js:youtubeImportFailureRef(result, copy.allFailedRef)': ['import:youtube.import.failure', 'import:youtube.failure.known'],
  'src/components/common/ImportNoticeToast.jsx:message.key': ['import:landing.graphOnly.notice'],
  'src/components/PodcastImport/PodcastImportFunnel.jsx:step.labelKey': ['import:podcast.feed.step', 'import:podcast.episodes.step'],
  'src/components/YoutubeImport/YoutubeImportFunnel.jsx:step.labelKey': ['import:youtube.address.step', 'import:youtube.videos.step', 'import:youtube.audio.step'],
  'src/components/EditPack/bundleChildren.js:VERDICT_LABELS[status] ?? VERDICT_LABELS[BUNDLE_CHILD_STATUS.error]': ['import:bundle.verdict.editable', 'import:bundle.verdict.readOnly', 'import:bundle.verdict.unsupported', 'import:bundle.verdict.error'],
  'src/components/EditPack/bundleChildren.js:units[unit]': ['import:bundle.size.kilobytes', 'import:bundle.size.megabytes', 'import:bundle.size.gigabytes'],
  'src/components/EditPack/importErrorPresentation.js:FALLBACK_MESSAGES[context] ?? FALLBACK_MESSAGES.open': ['import:error.open.fallback', 'import:error.simulate.fallback', 'import:error.graph.fallback', 'import:error.readOnly.fallback', 'import:error.unsupported.fallback'],
"src/components/AdvancedWorkspace/ActionEditor.jsx:ORDER_HELP": ["graph:action.order.help"],
"src/components/AdvancedWorkspace/ActionEditor.jsx:OPENER_SLOT_LABELS.ok": ["graph:connections.route.label"],
"src/components/AdvancedWorkspace/ActionEditor.jsx:OPENER_SLOT_LABELS.home": ["graph:connections.home.label"],
"src/components/AdvancedWorkspace/DeleteSelectionDialog.jsx:ENTRY_NOT_REMOVABLE": ["graph:remove.selection.entry"],
"src/components/AdvancedWorkspace/GraphSelectionEditor.jsx:message.key": ["graph:selection.error.image","graph:selection.error.audio","graph:selection.error.voice"],
"src/components/AdvancedWorkspace/StageArrivals.jsx:RANDOM_HOW[opener.slot]": ["graph:arrivals.route.random","graph:arrivals.home.random"],
"src/components/AdvancedWorkspace/StageArrivals.jsx:HOW[opener.slot]": ["graph:arrivals.route.label","graph:arrivals.home.label"],
"src/components/AdvancedWorkspace/StageArrivals.jsx:WHEEL_HELP": ["graph:arrivals.wheel.help"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:DEVICE_RETURN_HELP": ["graph:destinations.home.help"],
"src/components/AdvancedWorkspace/StageWheel.jsx:SIDES[neighbour.side].text": ["graph:wheel.side.previous","graph:wheel.side.next","graph:wheel.side.both"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.formTitle": ["graph:destinations.route.formTitle","graph:destinations.home.formTitle"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.formNote": ["graph:destinations.route.formNote","graph:destinations.home.formNote"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.title": ["graph:controls.route.title","graph:controls.home.label"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.copy": ["graph:destinations.route.copy","graph:destinations.home.copy"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.triggerLabel": ["graph:destinations.route.trigger"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.triggerHelp": ["graph:destinations.route.help"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.destinationLabel": ["graph:destinations.route.label","graph:destinations.home.label"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.unused": ["graph:destinations.route.unused","graph:destinations.home.unused"],
"src/components/AdvancedWorkspace/StageDestinations.jsx:exit.idle": ["graph:destinations.route.idle"],
"src/store/advancedAuthoring/diagnosticResolutions.js:category": ["graph:diagnostics.structure.category","graph:diagnostics.decision.category","graph:diagnostics.controls.category","graph:diagnostics.navigation.category","graph:diagnostics.document.category"],
"src/store/advancedAuthoring/diagnosticResolutions.js:message": ["graph:diagnostics.stageId.empty","graph:diagnostics.stageId.duplicate","graph:diagnostics.actionId.empty","graph:diagnostics.actionId.duplicate","graph:diagnostics.entry.count","graph:diagnostics.transition.missing","graph:diagnostics.option.null","graph:diagnostics.option.missing","graph:diagnostics.selection.invalid","graph:diagnostics.group.incoherent","graph:diagnostics.action.orphan","graph:diagnostics.transition.severed","graph:diagnostics.position.stale","graph:diagnostics.position.range","graph:diagnostics.opaque.stale","graph:diagnostics.opaque.required","graph:diagnostics.controls.incomplete","graph:diagnostics.home.loop","graph:diagnostics.ok.loop","graph:diagnostics.ok.missing","graph:diagnostics.exit.absent","graph:diagnostics.entry.option","graph:diagnostics.decode.invalid","graph:diagnostics.structure.invalid"],
"src/store/advancedAuthoring/diagnosticResolutions.js:fieldKey": ["graph:diagnostics.media.image","graph:diagnostics.media.audio"],
"src/store/advancedAuthoring/diagnosticResolutions.js:position.label": ["graph:diagnostics.position.scale","graph:diagnostics.position.omit","graph:diagnostics.position.preserve"],
"src/store/advancedAuthoring/diagnosticResolutions.js:opaque.label": ["graph:diagnostics.opaque.preserve","graph:diagnostics.opaque.remove","graph:diagnostics.opaque.promote"],
"src/i18n/graphPresentation.js:value.key": ["graph:drop.reason.kind", "graph:drop.reason.stage", "graph:drop.reason.path","graph:guard.text.required","graph:guard.rank.required","graph:guard.enum.required","graph:guard.controls.required","graph:guard.control.label","graph:guard.stages.required","graph:guard.permutation.required","graph:guard.nodes.required","graph:guard.metadata.required","graph:guard.metadata.label","graph:guard.group.required","graph:guard.layout.required","graph:guard.construction.disabled","graph:link.port.route","graph:link.port.home","graph:link.port.missing","graph:action.choice.add","graph:link.reason.stage","graph:link.reason.action","graph:link.reason.entry","graph:link.guard.existing","graph:link.guard.landing","graph:link.guard.position","graph:link.guard.layout","graph:selection.error.image","graph:selection.error.audio","graph:selection.error.voice","graph:selection.error.title"],
  "src/components/AdvancedWorkspace/ActionSelectionFields.jsx:LANDING_HELP": ["graph:landing.order.help"],
  "src/components/AdvancedWorkspace/LandingSelect.jsx:LANDING_HELP": ["graph:landing.order.help"],
  "src/components/AdvancedWorkspace/ListenFromActionDialog.jsx:STATE_TEXT[one.state]": ["graph:listen.choice.empty","graph:listen.choice.missing"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:CONTROL_LABELS[key]": ["graph:controls.wheel.label","graph:controls.ok.label","graph:controls.home.label","graph:controls.pause.label","graph:controls.autoplay.label"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:CONTROL_LABELS[control]": ["graph:controls.wheel.label","graph:controls.ok.label","graph:controls.home.label","graph:controls.pause.label","graph:controls.autoplay.label"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:CONTROL_PHRASES[control]": ["graph:controls.ok.phrase","graph:controls.autoplay.phrase","graph:controls.home.label","graph:controls.pause.label","graph:controls.wheel.label"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:label": ["graph:controls.ok.phrase","graph:controls.autoplay.phrase","graph:controls.home.label","graph:controls.pause.label","graph:controls.wheel.label"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:group.title": ["graph:controls.route.title","graph:controls.home.label","graph:controls.wheel.title","graph:controls.pause.title"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:text": ["graph:controls.presence.enabled","graph:controls.presence.disabled","graph:controls.presence.null","graph:controls.presence.absent"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:field.value === true ? 'graph:controls.state.enabled' : 'graph:controls.state.disabled'": ["graph:controls.state.enabled","graph:controls.state.disabled"],
  "src/components/AdvancedWorkspace/ControlsEditor.jsx:controls.presence !== 'value' ? 'graph:controls.completion.absent' : 'graph:controls.completion.partial'": ["graph:controls.completion.absent","graph:controls.completion.partial"],
  'src/i18n/graphPresentation.js:linkCountKey': ['graph:overlay.landmark.linkCount'],
  "src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx:group.titleKey": ["graph:edge.route.label","graph:edge.boutonAccueil.label","graph:creationControls.wheel.groupTitle","graph:creationControls.pause.groupTitle"],
  "src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx:CREATION_CONTROL_LABELS[control]": ["graph:creationControls.ok.phrase","graph:creationControls.autoplay.phrase","graph:edge.boutonAccueil.label","graph:creationControls.pause.label","graph:creationControls.wheel.label"],
  "src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx:CREATION_CONTROL_SHORT_LABELS[key]": ["graph:creationControls.wheel.label","graph:creationControls.ok.label","graph:edge.boutonAccueil.label","graph:creationControls.pause.label","graph:creationControls.autoplay.label"],
  "src/components/AdvancedGraphCanvas/GraphCanvasStage.jsx:linkNotice": ["graph:canvas.link.entryRefused","graph:canvas.link.stageNeedsList","graph:canvas.link.listNeedsStage"],
  // Tables fermées de la surface graphe : seules ces clés sont admissibles.
  "src/components/AdvancedGraphCanvas/GraphCanvasStage.jsx:NOTICE_TEXT[notice.kind]": ["graph:canvas.savedCameraPositionCannotBeUsedViewFittedAgain.label","graph:canvas.anchors.ignoredCount","graph:canvas.previousViewCannotBeReadViewRebuilt.label","graph:canvas.cache.armed"],
  "src/components/AdvancedGraphCanvas/GraphInspector.jsx:PRESENCE_LABELS[field?.presence ?? 'absent']": ["graph:inspector.absent.label","graph:inspector.null.label","graph:inspector.valeur.label"],
  "src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx:failure": ["graph:arrangement.arrangementWasRefusedNothingWasChanged.label"],
  "src/components/AdvancedWorkspace/CreateConstructionDialog.jsx:label": ["graph:construction.scene.label","graph:construction.kind.choice","graph:construction.sequence.label","graph:construction.kind.random"],
  "src/hooks/graphCopyFlow.js:GRAPH_COPY_TITLE_KEY": ["graph:copy.continueInTheGraphEditor.label"],
  "src/hooks/graphCopyFlow.js:SAVE_ORIGINAL_FIRST_KEY": ["graph:copy.saveYourProjectFirstTheGraphCopyWillBe.label"],
  "src/store/advancedGraphView/graphViewModel.js:UNNAMED_LIST_LABEL": ["graph:node.unnamed.label"],
  "src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx:filter.title": ["graph:surface.homeButtonWithNoDestinationLuniiReturnsToThe.label","graph:surface.choiceDrawnAtRandomEachTimeTheListOpens.label"],
  "src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx:filter.ariaLabel": ["graph:surface.showStructuralLinks.label","graph:surface.showReturns.label","graph:surface.showDefaultLuniiReturns.label","graph:surface.showLinksWithRandomSelection.label"],
  "src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx:filter.label": ["graph:surface.structure.label","graph:surface.retour.label","graph:surface.retourLunii.label","graph:surface.aleatoire.label"],
  'src/components/TreePanel/TreeDisplayPopover.jsx:help': ['tree:display.badges.help','tree:display.guides.help'],
  'src/components/TreePanel/TreeDisplayPopover.jsx:label': ['tree:display.badges.label','tree:display.guides.label'],
  'src/components/diagram/diagram/DiagramSearch.jsx:TYPE_LABELS[entry.type]': ['tree:menu.card.title','tree:story.type.label','tree:node.imported.label'],
  'src/components/diagram/flowDiagramLayout.js:TYPE_LABEL_KEYS[type]': ['tree:navigation.root.short','tree:menu.card.title','tree:story.type.label','tree:nodeType.zip','common:status.end.fallback'],
  'src/components/tree/nodeColorFilter.js:key': ['tree:color.red.label','tree:color.orange.label','tree:color.yellow.label','tree:color.green.label','tree:color.blue.label','tree:color.purple.label','tree:color.pink.label'],
  "src/components/editors/MenuEditor.jsx:label": ["tree:control.wheel.selection","tree:control.autoplay.label","tree:control.pause.title"],
  // Lot 4.5 : tables fermées du domaine Médias, clés littérales déclarées dans leurs fichiers.
  'src/components/AudioEditorModal/AudioEditorFadeOverlays.jsx:config.labelKey': ['media:audioEditor.fade.in', 'media:audioEditor.fade.out', 'media:audioEditor.fade.cut'],
  'src/components/MediaExplorer/MediaExplorerContent.jsx:col.labelKey': ['media:explorer.column.name', 'media:explorer.column.usage', 'media:explorer.column.size', 'media:explorer.column.dimensions', 'media:explorer.column.duration', 'media:explorer.column.format', 'media:explorer.column.date', 'media:explorer.column.path', 'media:explorer.column.tags'],
  'src/components/MediaExplorer/MediaExplorerImpl.jsx:col.labelKey': ['media:explorer.column.name', 'media:explorer.column.usage', 'media:explorer.column.size', 'media:explorer.column.dimensions', 'media:explorer.column.duration', 'media:explorer.column.format', 'media:explorer.column.date', 'media:explorer.column.path', 'media:explorer.column.tags'],
  'src/components/MediaExplorer/MediaExplorerImpl.jsx:f.labelKey': ['media:explorer.filter.all', 'media:explorer.filter.images', 'media:explorer.filter.audio', 'media:explorer.filter.zip', 'media:explorer.filter.ai', 'media:explorer.filter.imported', 'media:explorer.filter.recorded', 'media:explorer.filter.unused'],
  'src/hooks/useMediaSubscriptions.js:value': ['media:subscriptions.error.missingProject', 'media:subscriptions.error.youtubeNotReady', 'media:subscriptions.registry.unreadable', 'media:subscriptions.registry.writeFailed', 'media:subscriptions.check.cancelled', 'media:subscriptions.source.incomplete', 'media:subscriptions.source.unstableId', 'media:subscriptions.source.tooLarge'],
  'src/store/mediaLibrary.js:SOURCE_LABEL_KEYS[source]': ['media:usage.source.project', 'media:usage.source.advanced', 'media:usage.source.nativeGraph', 'media:usage.source.storyTitle', 'media:usage.source.storyEnd', 'media:explorer.kind.archive', 'media:usage.source.library'],
  'src/components/MissingMediaRelink/MissingMediaRelinkModal.jsx:KIND_LABEL_KEYS[row.kind]': ['media:relink.kind.audio', 'media:relink.kind.image', 'media:relink.kind.archive', 'media:relink.kind.media'],
  "src/components/editors/MenuEditor.jsx:desc": ["tree:menu.wheel.description","tree:menu.autoplay.description","tree:menu.pause.description"],
  "src/components/editors/MultiEditor.jsx:label": ["tree:control.pause.title","tree:control.wheel.selection","tree:control.autoplay.label","tree:control.pause.label"],
  "src/components/editors/MultiEditor.jsx:desc": ["tree:multi.pause.description","tree:multi.wheel.description","tree:multi.autoplay.description","tree:multi.titlePause.description"],
  "src/components/editors/NativeGraphEditor.jsx:CONTROL_LABELS[key]": ["tree:nativeGraph.control.wheel","tree:nativeGraph.control.autoplay","tree:nativeGraph.control.pause","tree:nativeGraph.control.ok","tree:nativeGraph.control.home"],
  "src/components/editors/RootEditor.jsx:AUTO_NEXT_TOOLTIP": ["tree:root.autoNext.description"],
  "src/components/editors/StoryEditor.jsx:NAV_ROOT_LABEL": ["tree:navigation.root.label"],
  "src/components/editors/story/AfterPlaySection.jsx:NAV_ROOT_LABEL": ["tree:navigation.root.label"],
  "src/components/editors/story/AfterPlaySection.jsx:label": ["tree:control.autoplay.label","tree:control.ok.label","tree:control.home.label","tree:control.pause.label","tree:control.wheel.label"],
  "src/components/editors/story/DuringPlaySection.jsx:label": ["tree:control.pause.title","tree:story.titleAutoplay.label","tree:control.ok.label","tree:control.home.label","tree:control.pause.label","tree:control.wheel.label"],
  "src/components/editors/story/DuringPlaySection.jsx:pauseEnabled ? onText : offText": ["tree:story.pause.enabled","tree:story.pause.disabled"],
  "src/components/editors/story/DuringPlaySection.jsx:tip": ["tree:story.titleAutoplay.description","tree:story.titleOk.description","tree:story.titleHome.description","tree:story.titlePause.description","tree:story.titleWheel.description"],
  "src/components/editors/story/EndSequenceEditor.jsx:label": ["tree:control.autoplay.label","tree:control.ok.label","tree:control.home.label","tree:control.pause.label","tree:control.wheel.label"],
  "src/components/editors/story/storyUtils.jsx:NAV_ROOT_LABEL": ["tree:navigation.root.label"],
  "src/store/packMetadataModel.js:noticeRef.key": ["tree:metadata.save.held","tree:metadata.save.busy","tree:metadata.save.stale","tree:metadata.save.refused","tree:metadata.save.notApplied"],
  'src/components/editors/ImageField.jsx:labelKey': ['tree:image.replace.action', 'tree:image.edit.action', 'tree:image.title.generate', 'tree:image.ai.generate', 'tree:image.clear.action'],
  'src/store/projectStorage.js:key': ['home:project.storage.invalid', 'home:project.storage.duplicate', 'home:project.storage.exhausted'],
  'src/components/AggregatePacks/AggregatePacksFunnel.jsx:step.labelKey': ['home:aggregate.step.packs', 'home:aggregate.step.audio', 'home:aggregate.step.image', 'home:aggregate.step.metadata'],
  // Tables fermées du shell ; clés explicites validées même avant leur rendu.
  'src/components/common/ReleaseNotesModal.jsx:title': [
    'common:releaseNotes.current.queue.title',
    'common:releaseNotes.current.sound.title',
    'common:releaseNotes.current.updates.title',
    'common:releaseNotes.current.episodes.title',
    'common:releaseNotes.current.fixes.label',
  ],
  'src/components/common/ReleaseNotesModal.jsx:detail': [
    'common:releaseNotes.current.queue.detail',
    'common:releaseNotes.current.sound.detail',
    'common:releaseNotes.current.updates.detail',
    'common:releaseNotes.current.episodes.detail',
  ],
  'src/store/toolbarModel.js:labelKey': [
    'common:project.home.label',
    'common:project.open.label',
    'common:project.openPack.label',
    'common:project.save.label',
    'common:project.saveAs.label',
    'common:project.continueInGraph.label',
    'common:toolbar.undo.label',
    'common:toolbar.redo.label',
    'common:toolbar.tree.toggle',
    'common:toolbar.settings.toggle',
    'common:toolbar.diagram.toggle',
    'common:toolbar.nodeList.toggle',
    'common:toolbar.issues.label',
    'common:toolbar.generate.label',
    'common:toolbar.preferences.label',
  ],
  'src/store/toolbarModel.js:reason': [
    'common:toolbar.export.suspended',
    'common:toolbar.gesture.suspended',
    'common:toolbar.undo.unavailable',
    'common:toolbar.redo.unavailable',
    'common:toolbar.generate.blocked',
    'common:toolbar.generate.checking',
    'common:toolbar.document.loading',
  ],
  // Lot 4.9 : tables fermées du vérificateur et des rapports, clés littérales déclarées dans leurs fichiers.
  "src/components/CommunityPackChecker/CommunityPackChecker.jsx:group.titleKey": ["checker:issue.saturated.title", "checker:issue.listen.title", "checker:issue.silence.title", "checker:issue.optionalSilence.title", "checker:issue.volume.title", "checker:issue.audioFormat.title", "checker:issue.imageCorrection.title", "checker:issue.packName.title", "checker:issue.structure.title"],
  "src/components/CommunityPackChecker/CommunityPackChecker.jsx:group.badgeKey": ["checker:issue.badge.source", "checker:issue.badge.manual", "checker:issue.badge.auto", "checker:issue.badge.optional", "checker:issue.badge.assisted"],
  "src/components/CommunityPackChecker/CommunityPackChecker.jsx:key": ["checker:issue.saturated.explanation", "checker:issue.listen.explanation", "checker:issue.silence.explanation", "checker:issue.optionalSilence.explanation", "checker:issue.volume.explanation", "checker:issue.audioFormat.explanation", "checker:issue.image.explanation", "checker:issue.packName.explanation", "checker:issue.structure.explanation", "checker:issue.saturated.action", "checker:issue.listen.action", "checker:issue.silence.action", "checker:issue.optionalSilence.action", "checker:issue.volume.action", "checker:issue.audioFormat.action", "checker:issue.image.action", "checker:issue.packName.action", "checker:issue.structure.action"],
  "src/components/CommunityPackChecker/CommunityPackChecker.jsx:summary.titleKey": ["checker:verdict.conform.title", "checker:verdict.blocking.title", "checker:verdict.saturatedFixable.title", "checker:verdict.saturated.title", "checker:verdict.listen.title", "checker:verdict.optional.title", "checker:verdict.fixable.title"],
  "src/components/CommunityPackChecker/CommunityPackChecker.jsx:summary.subtitleKey": ["checker:verdict.conform.subtitle", "checker:verdict.blocking.subtitle", "checker:verdict.saturatedFixable.subtitle", "checker:verdict.saturated.subtitle", "checker:verdict.listen.subtitle", "checker:verdict.optional.subtitle", "checker:verdict.fixable.subtitle"],
  "src/components/CommunityPackChecker/CommunityPackCheckerFunnel.jsx:entry.labelKey": ["checker:funnel.step.pack", "checker:funnel.step.report", "checker:funnel.step.correction"],
  "src/components/CommunityPackChecker/communityPackExports.js:titleKey": ["checker:verdict.conform.title", "checker:verdict.blocking.title", "checker:verdict.saturatedFixable.title", "checker:verdict.saturated.title", "checker:verdict.listen.title", "checker:verdict.optional.title", "checker:verdict.fixable.title"],
  "src/components/CommunityPackChecker/communityPackExports.js:subtitleKey": ["checker:verdict.conform.subtitle", "checker:verdict.blocking.subtitle", "checker:verdict.saturatedFixable.subtitle", "checker:verdict.saturated.subtitle", "checker:verdict.listen.subtitle", "checker:verdict.optional.subtitle", "checker:verdict.fixable.subtitle"],
  "src/components/CommunityPackChecker/communityPackExports.js:group.titleKey": ["checker:issue.saturated.title", "checker:issue.listen.title", "checker:issue.silence.title", "checker:issue.optionalSilence.title", "checker:issue.volume.title", "checker:issue.audioFormat.title", "checker:issue.imageCorrection.title", "checker:issue.packName.title", "checker:issue.structure.title"],
  "src/components/CommunityPackChecker/communityPackExports.js:group.badgeKey": ["checker:issue.badge.source", "checker:issue.badge.manual", "checker:issue.badge.auto", "checker:issue.badge.optional", "checker:issue.badge.assisted"],
  "src/components/CommunityPackChecker/communityPackExports.js:group.actionKey": ["checker:issue.saturated.exportAction", "checker:issue.listen.action", "checker:issue.silence.action", "checker:issue.optionalSilence.exportAction", "checker:issue.volume.action", "checker:issue.audioFormat.action", "checker:issue.image.action", "checker:issue.packName.exportAction", "checker:issue.structure.action"],
  "src/components/CommunityPackChecker/useCommunityPackChecker.js:config.filterKey": ["native:checker.report.html.filterLabel", "native:checker.report.markdown.filterLabel", "native:checker.report.log.filterLabel", "native:checker.report.json.filterLabel"],
  "src/components/CommunityPackChecker/useCommunityPackChecker.js:config.noticeKey": ["checker:export.notice.html", "checker:export.notice.markdown", "checker:export.notice.log", "checker:export.notice.json"],
  "src/store/advancedExport/exportOutcome.js:table[value]": ["checker:refusal.title.decode", "checker:refusal.title.preparation", "checker:refusal.title.media", "checker:refusal.title.collision", "checker:refusal.title.oracle", "checker:refusal.title.cancelled", "checker:refusal.title.write", "checker:refusal.title.untyped", "checker:refusal.title.request", "checker:refusal.preparation.integrity", "checker:refusal.preparation.author", "checker:refusal.preparation.identity", "checker:refusal.preparation.readiness", "checker:refusal.preparation.serialization", "checker:media.cause.bindingAbsent", "checker:media.cause.pathNull", "checker:media.cause.notFound", "checker:media.cause.notRegular", "checker:media.cause.readDenied", "checker:media.cause.empty", "checker:media.cause.undecodable", "checker:media.cause.validationFailed", "checker:media.cause.toolUnavailable", "checker:media.cause.toolInterrupted", "checker:media.cause.processingFailed", "checker:media.transformation.verbatim", "checker:media.transformation.renamed", "checker:media.transformation.reencoded", "checker:media.transformation.resized", "checker:media.field.image", "checker:media.field.audio"],
  "src/store/advancedExport/exportReadiness.js:table[value]": ["checker:readiness.qualification.untested", "checker:readiness.qualification.prepared", "checker:readiness.qualification.supported", "checker:readiness.source.decode", "checker:readiness.source.integrity", "checker:readiness.source.authoring", "checker:readiness.source.readiness", "checker:readiness.level.info", "checker:readiness.level.warning", "checker:readiness.level.action", "checker:readiness.level.error"],
  "src/store/advancedExport/exportReadiness.js:QUALIFICATION_LABELS.UNTESTED": ["checker:readiness.qualification.untested"],
  // Lot 4.12 : tables fermées des exemples (titres et descriptions des cinq exemples, langue parlée).
  'src/components/AdvancedWorkspace/ExamplesMenu.jsx:example.titleKey': ['examples:garden.example.title', 'examples:castle.example.title', 'examples:rabbit.example.title', 'examples:lighthouse.example.title', 'examples:train.example.title'],
  'src/components/AdvancedWorkspace/ExamplesMenu.jsx:example.descriptionKey': ['examples:garden.example.description', 'examples:castle.example.description', 'examples:rabbit.example.description', 'examples:lighthouse.example.description', 'examples:train.example.description'],
  'src/components/AdvancedWorkspace/ExampleDialog.jsx:state.example.titleKey': ['examples:garden.example.title', 'examples:castle.example.title', 'examples:rabbit.example.title', 'examples:lighthouse.example.title', 'examples:train.example.title'],
  'src/components/AdvancedWorkspace/ExampleDialog.jsx:state.example.descriptionKey': ['examples:garden.example.description', 'examples:castle.example.description', 'examples:rabbit.example.description', 'examples:lighthouse.example.description', 'examples:train.example.description'],
  'src/components/AdvancedWorkspace/ExampleDialog.jsx:LANGUAGE_KEYS[voice.language]': ['ai:voice.language.fr', 'ai:voice.language.en', 'ai:voice.language.it'],
  'src/store/xttsSettings.js:option.labelKey': ['ai:voice.language.fr', 'ai:voice.language.enGB', 'ai:voice.language.enUS', 'ai:voice.language.it'],
  'src/tabs/OptionsTab/PiperVoiceSettings.jsx:labelKey': ['ai:voice.language.fr', 'ai:voice.language.enGB', 'ai:voice.language.enUS', 'ai:voice.language.it'],
  'src/tabs/OptionsTab/XttsVoiceSettings.jsx:labelKey': ['ai:voice.language.fr', 'ai:voice.language.en', 'ai:voice.language.es', 'ai:voice.language.de', 'ai:voice.language.it', 'ai:voice.language.pt'],
  'src/tabs/OptionsTab/InterfaceSection.jsx:LANGUAGE_LABEL_KEYS[language]': ['settings:interface.language.'],
  'src/tabs/OptionsTab/InterfaceSection.jsx:option.labelKey': ['settings:interface.theme.'],
  'src/tabs/OptionsTab/OptionsSectionNav.jsx:group.labelKey': ['settings:navigation.'],
  'src/tabs/OptionsTab/OptionsSectionNav.jsx:item.labelKey': ['settings:navigation.', 'settings:interface.section.title', 'media:subscriptions.section.title'],
};

export function sourceHash(text) {
  return createHash('sha256').update(text.normalize('NFC').replace(/\r\n?/g, '\n')).digest('hex').slice(0, 12);
}

function flatten(value, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, full, result);
    else result[full] = item;
  }
  return result;
}

function tokens(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1].trim()).sort();
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

// Noms de formats et mots identiques dans la langue cible (bibliothèque de packs).
export const CATALOGUE_NEUTRAL_KEYS = {
  en: new Set(['lunii.unknownValue', 'lunii.position', 'toolbar.search.shortcut', 'tags.moreCount', 'toolbar.count.packs_one', 'toolbar.count.packs_many', 'toolbar.count.packs_other', 'startup.page.catalogue', 'fiche.edit.modeLabel', 'fiche.edit.field.description', 'fiche.edit.field.bonus', 'fiche.edit.language.ca', 'fiche.edit.language.eu', 'fiche.edit.language.br', 'fiche.edit.language.oc', 'open.choice.option.label', 'open.choice.option.detail', 'format.zip.label', 'format.sevenZip.label', 'filter.family.format', 'toolbar.sort.format', 'filter.family.collection', 'formatTag.count', 'details.duration.minutes_one', 'details.duration.minutes_other', 'details.version.value', 'details.column.version', 'exemplar.column.format', 'exemplar.column.actions', 'fiche.field.uuid', 'toolbar.view.cards', 'details.value.notProvided', 'fiche.edit.origin.none', 'details.duration.hours_one', 'details.duration.hours_other', 'details.duration.hoursMinutes_one', 'details.duration.hoursMinutes_other', 'details.duration.hours_many', 'details.duration.hoursMinutes_many', 'fiche.modal.position', 'selection.panel.tagCount']),
  it: new Set(['toolbar.density.normal', 'toolbar.density.large', 'lunii.unknownValue', 'toolbar.search.shortcut', 'tags.moreCount', 'toolbar.count.packs_one', 'fiche.edit.field.bonus', 'open.choice.option.label', 'open.choice.option.detail', 'format.zip.label', 'format.sevenZip.label', 'formatTag.count', 'details.duration.minutes_one', 'details.duration.minutes_many', 'details.duration.minutes_other', 'details.version.value', 'fiche.field.uuid', 'details.value.notProvided', 'fiche.edit.origin.none', 'details.duration.hours_one', 'details.duration.hours_other', 'details.duration.hoursMinutes_one', 'details.duration.hoursMinutes_other', 'details.duration.hours_many', 'details.duration.hoursMinutes_many', 'fiche.modal.position', 'selection.panel.tagCount']),
};

export const SETTINGS_NEUTRAL_KEYS = new Set(['interface.section.title', 'interface.language.french', 'interface.language.english', 'interface.language.italian', 'interface.language.pseudo', 'navigation.youtube.label', 'youtube.section.title', 'consolidate.summary.warning', 'end.remove.message']);

// Sans options, conserver le contrat historique des tests de catalogues.
// Le contrôle de projet applique la sévérité selon les langues publiques.
export function checkCatalogues(resources, metadata, rustMessages, messageFixtures = [], { publicLanguages } = {}) {
  const errors = [], warnings = [];
  const report = (message) => errors.push(message);
  const namespaces = new Set(LANGUAGES.flatMap((language) => Object.keys(resources[language] ?? {})));
  for (const namespace of namespaces) {
    // Le runtime charge ces objets avec keySeparator:false : une hiérarchie JSON
    // peut réussir la parité après flatten tout en déclenchant un repli FR réel.
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(resources[language]?.[namespace] ?? {})) {
        if (value !== null && typeof value === 'object') report(`${language}/${namespace}:${key} catalogue imbriqué incompatible avec keySeparator:false`);
      }
    }
    const catalogues = Object.fromEntries(LANGUAGES.map((language) => [language, flatten(resources[language]?.[namespace] ?? {})]));
    const fr = catalogues.fr;
    const meta = metadata[namespace] ?? {};
    const allKeys = new Set(Object.values(catalogues).flatMap(Object.keys));
    const bases = new Set([...allKeys].filter((key) => PLURAL.test(key)).map((key) => key.replace(PLURAL, '')));
    for (const base of bases) {
      for (const language of LANGUAGES) {
        for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
          if (!Object.hasOwn(catalogues[language], `${base}_${category}`)) report(`${language}/${namespace}:${base}_${category} pluriel absent`);
        }
      }
    }
    for (const key of allKeys) {
      const base = key.replace(PLURAL, '');
      const category = key.match(PLURAL)?.[1];
      const source = fr[key] ?? fr[`${base}_other`];
      if (!Object.hasOwn(fr, key)) report(`fr/${namespace}:${key} clé cible sans source`);
      for (const language of LANGUAGES) {
        const value = catalogues[language][key];
        // La parité porte sur la famille, car EN ne requiert pas _many.
        const required = !category || new Intl.PluralRules(language).resolvedOptions().pluralCategories.includes(category);
        if (value === undefined && required) report(`${language}/${namespace}:${key} clé absente`);
        if (value === undefined) continue;
        if (['home', 'tree', 'graph', 'import', 'native', 'media', 'ai', 'production', 'checker', 'settings', 'help', 'examples', 'catalogue'].includes(namespace) && language !== 'fr' && value === source && !(namespace === 'help' && HELP_NEUTRAL_KEYS[language]?.has(key)) && !(namespace === 'examples' && EXAMPLES_NEUTRAL_KEYS[language]?.has(key)) && !(namespace === 'settings' && SETTINGS_NEUTRAL_KEYS.has(key)) && !(namespace === 'checker' && CHECKER_NEUTRAL_KEYS[language]?.has(base)) && !(namespace === 'production' && ['native.title.qualified', 'report.measurement.gain'].includes(key)) && !(namespace === 'ai' && AI_NEUTRAL_KEYS[language]?.has(key)) && !(namespace === 'tree' && (TREE_NEUTRAL_KEYS.has(key) || TREE_LANGUAGE_NEUTRAL_KEYS[language]?.has(key))) && !(namespace === 'graph' && GRAPH_NEUTRAL_KEYS.has(key)) && !(namespace === 'home' && HOME_NEUTRAL_KEYS.has(key)) && !(namespace === 'media' && MEDIA_NEUTRAL_KEYS.has(key)) && !(namespace === 'catalogue' && CATALOGUE_NEUTRAL_KEYS[language]?.has(key)) && !IMPORT_NATIVE_NEUTRAL_KEYS.has(`${namespace}:${key}`)) report(`${language}/${namespace}:${key} règle d’or : texte français`);
        if (typeof value !== 'string' || !value.trim()) { report(`${language}/${namespace}:${key} valeur vide ou non textuelle`); continue; }
        if (typeof source === 'string') {
          if (!same(tokens(source, /{{\s*([^}]+)\s*}}/g), tokens(value, /{{\s*([^}]+)\s*}}/g))) report(`${language}/${namespace}:${key} paramètres différents`);
          if (!same(tokens(source, /<\s*(\/?[\w]+)\b[^>]*>/g), tokens(value, /<\s*(\/?[\w]+)\b[^>]*>/g))) report(`${language}/${namespace}:${key} balises Trans différentes`);
        }
        if (/<\s*\/?\d+\b/.test(value)) report(`${language}/${namespace}:${key} balise Trans positionnelle interdite`);
      }
    }
    for (const [key, source] of Object.entries(fr)) {
      const entry = meta[key];
      if (!entry || typeof entry.context !== 'string' || !entry.context.trim()) { report(`${namespace}:${key} contexte _meta absent`); continue; }
      if (entry.maxLength !== undefined && (!Number.isInteger(entry.maxLength) || entry.maxLength <= 0)) report(`${namespace}:${key} maxLength invalide`);
      for (const language of ['en', 'it']) {
        if (!Object.hasOwn(catalogues[language], key)) continue;
        const target = entry[language];
        if (!target || !STATUSES.has(target.status) || !/^[0-9a-f]{12}$/.test(target.sourceHash ?? '')) { report(`${language}/${namespace}:${key} métadonnées invalides`); continue; }
        if (publicLanguages === undefined && typeof source === 'string' && (target.sourceHash !== sourceHash(source) || target.status === 'stale')) report(`${language}/${namespace}:${key} stale`);
        if (entry.maxLength) {
          const text = String(catalogues[language][key]).replace(/{{[^}]+}}/g, '').replace(/<[^>]+>/g, '');
          const length = [...new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(text)].length;
          if (length > entry.maxLength) warnings.push(`${language}/${namespace}:${key} maxLength dépassé (${length})`);
        }
      }
      for (const language of ['en', 'it']) {
        if (entry[language] && !Object.hasOwn(catalogues[language], key)) report(`${language}/${namespace}:${key} _meta cible orpheline`);
      }
    }
    for (const key of Object.keys(meta)) if (!Object.hasOwn(fr, key)) report(`${namespace}:${key} _meta orpheline`);
  }
  for (const namespace of Object.keys(metadata)) if (!namespaces.has(namespace)) report(`${namespace} namespace _meta orphelin`);
  if (rustMessages) {
    // Contrat prévu : liste de descripteurs { code, params } (ou { messages: […] }).
    const messages = Array.isArray(rustMessages) ? rustMessages : rustMessages.messages;
    if (!Array.isArray(messages)) report('rust-messages: schéma invalide');
    else {
      const codes = new Set();
      for (const { code, params, label, plural } of messages) {
        if (label !== undefined && label !== true) report(`rust-messages: libellé invalide ${code}`);
        if (typeof code !== 'string' || !code || /[:.]/.test(code)) { report('rust-messages: code invalide'); continue; }
        if (codes.has(code)) report(`rust-messages: code dupliqué ${code}`);
        codes.add(code);
        const names = Array.isArray(params) ? params : Object.keys(params ?? {});
        if (plural !== undefined && (typeof plural !== 'string' || !names.includes(plural))) report(`rust-messages: pluriel invalide ${code}`);
        for (const language of LANGUAGES) {
          const catalogue = resources[language]?.rust ?? {};
          const keys = plural ? [...new Set([
            ...new Intl.PluralRules(language).resolvedOptions().pluralCategories.map((category) => `${code}_${category}`),
            ...Object.keys(catalogue).filter((key) => PLURAL.test(key) && key.replace(PLURAL, '') === code),
          ])] : [code];
          if (plural && Object.hasOwn(catalogue, code)) report(`${language}/rust:${code} clé simple résiduelle`);
          if (!plural && Object.keys(catalogue).some((key) => PLURAL.test(key) && key.replace(PLURAL, '') === code)) report(`${language}/rust:${code} pluriel non déclaré`);
          for (const key of keys) {
            const text = catalogue[key];
            if (typeof text !== 'string') report(`${language}/rust:${key} code absent`);
            else if (!same([...new Set(tokens(text, /{{\s*([^}]+)\s*}}/g))].sort(), [...names].sort())) report(`${language}/rust:${key} paramètres du contrat différents`);
            if (plural && language !== 'fr' && text === resources.fr?.rust?.[key]) report(`${language}/rust:${key} règle d’or : texte français`);
          }
        }
      }
      // Les libellés imbriqués suivent le même contrat que les messages complets.
      // Valider les références des fixtures évite un FR correct mais un EN/IT
      // composé avec une phrase française ou une clé non enregistrée.
      const contracts = new Map(messages.map(({ code, params }) => [code, params]));
      const checkValue = (value, path) => {
        if (typeof value === 'string') {
          try { const parsed = JSON.parse(value); if (parsed?.code) checkValue(parsed, path); } catch { /* Donnée d’auteur brute. */ }
          return;
        }
        if (!value || typeof value !== 'object') return;
        if (value.code) {
          const context = value.params?.context;
          const code = typeof context === 'string' && context.startsWith(`${value.code}_`) && contracts.has(context) ? context : value.code;
          const names = contracts.get(code);
          if (!names) report(`rust-messages: référence imbriquée inconnue ${code} (${path})`);
          else for (const name of names) if (!Object.hasOwn(value.params ?? {}, name)) report(`rust-messages: référence ${code} paramètre ${name} absent (${path})`);
        }
        for (const [name, child] of Object.entries(value)) checkValue(child, `${path}.${name}`);
      };
      messageFixtures.forEach((fixture, index) => checkValue(fixture, `fixture[${index}]`));
      for (const code of new Set(LANGUAGES.flatMap((language) => Object.keys(resources[language]?.rust ?? {})))) if (!codes.has(code.replace(PLURAL, ''))) report(`rust:${code} code orphelin`);
    }
  }
  if (publicLanguages !== undefined) {
    const coverage = checkPublicLanguageCoverage(resources, metadata, publicLanguages);
    errors.push(...coverage.errors);
    warnings.push(...coverage.warnings);
  }
  return { errors, warnings };
}

export function checkPublicLanguageCoverage(resources, metadata, publicLanguages = PUBLIC_LANGUAGES) {
  const errors = [], warnings = [], counts = {};
  for (const language of LANGUAGES.filter((language) => language !== 'fr')) {
    counts[language] = Object.fromEntries([...STATUSES].map((status) => [status, 0]));
    for (const [namespace, catalogue] of Object.entries(resources[language] ?? {})) {
      const fr = flatten(resources.fr?.[namespace] ?? {});
      for (const key of Object.keys(flatten(catalogue))) {
        const target = metadata[namespace]?.[key]?.[language];
        if (!STATUSES.has(target?.status)) continue; // Le contrat _meta signale les entrées invalides.
        counts[language][target.status]++;
        const source = fr[key];
        const stale = target.status === 'stale' || (typeof source === 'string' && target.sourceHash !== sourceHash(source));
        if (stale || !['ai-reviewed', 'human'].includes(target.status)) {
          const message = `${language}/${namespace}:${key} couverture publique : ${stale ? 'stale' : target.status}`;
          (publicLanguages.includes(language) ? errors : warnings).push(message);
        }
      }
    }
  }
  return { errors, warnings, counts };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

export function checkSource(source, file, resources, rustMessages) {
  const errors = [], used = new Set();
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true });
  let defaultNamespace = 'common';
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.name === 'useTranslation') {
      const namespace = node.arguments[0]?.type === 'ArrayExpression' ? node.arguments[0].elements[0] : node.arguments[0];
      if (typeof namespace?.value === 'string') defaultNamespace = namespace.value;
    }
  });
  const checkKey = (raw, node, namespaceOverride = defaultNamespace) => {
    const [namespace, key] = raw.includes(':') ? raw.split(/:(.*)/s) : [namespaceOverride, raw];
    const catalogue = flatten(resources.fr?.[namespace] ?? {});
    if (!Object.hasOwn(catalogue, key) && !Object.keys(catalogue).some((candidate) => candidate.replace(PLURAL, '') === key)) errors.push(`${file}:${node.loc.start.line} clé FR absente ${namespace}:${key}`);
    used.add(`${namespace}:${key}`);
  };
  walk(ast, (node) => {
    let keyNode;
    let namespaceOverride = defaultNamespace;
    if (node.type === 'JSXOpeningElement') {
      const attribute = node.attributes.find((item) => item.name?.name === 'i18nKey');
      const namespace = node.attributes.find((item) => item.name?.name === 'ns')?.value;
      if (namespace?.type === 'Literal') namespaceOverride = namespace.value;
      keyNode = attribute?.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : attribute?.value;
    }
    // Le relais générique transmet les clés vérifiées à ses points d’appel ;
    // seuls ce fichier et cette signature exacte sont exclus de l’analyse dynamique.
    const graphForwarder = file === 'src/i18n/graphPresentation.js'
      && node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'CallExpression' && node.callee.object.callee.name === 'graphTranslationEngine'
      && node.callee.property.name === 't' && node.arguments[0]?.name === 'key' && node.arguments[1]?.name === 'params';
    if (node.type === 'CallExpression' && !graphForwarder && !(file === 'src/i18n/helpPresentation.js' && node.callee.type === 'MemberExpression' && ['i18next', 'source'].includes(node.callee.object.name) && node.callee.property.name === 't' && node.arguments[0]?.name === 'key' && node.arguments[1]?.name === 'params') && (node.callee.name === 't' || node.callee.name === 'translateGraph' || node.callee.name === 'translator' || node.callee.name === 'importPresentationError' || node.callee.name === 'translateMedia' || node.callee.name === 'productionRef' || node.callee.name === 'translateProduction' || node.callee.name === 'translateHelp' || node.callee.name === 'translateChecker' || node.callee.name === 'checkerRef' || node.callee.name === 'aiRef' || node.callee.name === 'translateAi' || (node.callee.type === 'MemberExpression' && node.callee.property.name === 't'))) {
      keyNode = node.arguments[0];
      const namespace = node.arguments[1]?.properties?.find((property) => (property.key.name ?? property.key.value) === 'ns')?.value;
      if (namespace?.type === 'Literal') namespaceOverride = namespace.value;
    }
    if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'labelKey') keyNode = node.value;
    if (node.type === 'Literal' && typeof node.value === 'string' && /^(?:home|tree|graph|import|native|media|ai|production|checker|settings|help|examples|catalogue):[a-zA-Z]+\.[a-zA-Z]+/.test(node.value)) { checkKey(node.value, node); return; }
    if (!keyNode) return;
    if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') { checkKey(keyNode.value, node, namespaceOverride); return; }
    if (keyNode.type === 'TemplateLiteral' && !keyNode.expressions.length) { checkKey(keyNode.quasis[0].value.cooked, node, namespaceOverride); return; }
    const expression = source.slice(keyNode.start, keyNode.end);
    const table = TABLE_CALLS[`${file}:${expression}`];
    if (table) {
      for (const family of table) {
        const keys = DYNAMIC_FAMILIES[family]?.map((suffix) => family + suffix) ?? [family];
        keys.forEach((key) => checkKey(key, node));
      }
      return;
    }
    if (keyNode.type === 'TemplateLiteral' && keyNode.expressions.length === 1 && keyNode.quasis[1].value.cooked === '') {
      const prefix = keyNode.quasis[0].value.cooked;
      const values = prefix === 'rust:' ? (rustMessages?.messages ?? rustMessages ?? []).map((entry) => entry.code) : DYNAMIC_FAMILIES[prefix];
      if (values?.length) { values.forEach((value) => checkKey(prefix + value, node)); return; }
    }
    errors.push(`${file}:${node.loc.start.line} clé dynamique non déclarée (${expression})`);
  });
  return { errors, used };
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const lists = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesUnder(resolve(directory, entry.name)) : [resolve(directory, entry.name)]));
  return lists.flat();
}

export async function checkProject(root = resolve('.'), { publicLanguages = PUBLIC_LANGUAGES } = {}) {
  const resources = {}, metadata = {};
  for (const language of LANGUAGES) {
    resources[language] = {};
    for (const file of await readdir(resolve(root, 'src/locales', language))) {
      if (file.endsWith('.json')) resources[language][file.slice(0, -5)] = JSON.parse(await readFile(resolve(root, 'src/locales', language, file), 'utf8'));
    }
  }
  for (const file of await readdir(resolve(root, 'src/locales/_meta'))) {
    if (file.endsWith('.json')) metadata[file.slice(0, -5)] = JSON.parse(await readFile(resolve(root, 'src/locales/_meta', file), 'utf8'));
  }
  let rustMessages;
  try { rustMessages = JSON.parse(await readFile(resolve(root, 'src/locales/_generated/rust-messages.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let messageFixtures = [];
  try { messageFixtures = JSON.parse(await readFile(resolve(root, 'scripts/fixtures/rust-p1-fr.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = checkCatalogues(resources, metadata, rustMessages, messageFixtures, { publicLanguages });
  result.statusCounts = checkPublicLanguageCoverage(resources, metadata, publicLanguages).counts;
  if (!rustMessages) result.errors.push('rust-messages: fichier obligatoire absent');
  const used = new Set((rustMessages?.messages ?? rustMessages ?? []).map(({ code }) => `rust:${code}`));
  used.add('common:error.fallback.unexpected');
  // Titres historiques reconnus via les catalogues dans advancedExamples/transaction.js.
  used.add('graph:creation.pack.defaultName');
  // Descripteurs stockés et présentateur statique du suivi, résolus hors JSX.
  for (const key of ['import:folder.read.prefix', 'import:project.recent.prefix', 'import:media.follow.pending', 'import:media.follow.active', 'import:media.follow.pauseOnSave', 'import:media.follow.resumeOnSave', 'import:media.follow.paused', 'import:media.follow.initial']) used.add(key);
  for (const path of await filesUnder(resolve(root, 'src'))) {
    if (!/\.(js|jsx)$/.test(path) || /\.(test|spec)\./.test(path) || (path.replaceAll('\\', '/').includes('/i18n/') && relative(root, path).replaceAll('\\', '/') !== 'src/i18n/graphPresentation.js')) continue;
    const checked = checkSource(await readFile(path, 'utf8'), relative(root, path).replaceAll('\\', '/'), resources, rustMessages);
    result.errors.push(...checked.errors);
    checked.used.forEach((key) => used.add(key));
  }
  for (const [namespace, catalogue] of Object.entries(resources.fr)) {
    for (const key of Object.keys(flatten(catalogue))) {
      if (!used.has(`${namespace}:${key}`) && !used.has(`${namespace}:${key.replace(PLURAL, '')}`)) result.warnings.push(`${namespace}:${key} clé orpheline`);
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkProject();
  console.log('i18n: fr = langue source (sans statut de traduction)');
  for (const [language, counts] of Object.entries(result.statusCounts)) {
    console.log(`i18n: ${language} : ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ')}`);
  }
  result.warnings.forEach((message) => console.warn(`Avertissement: ${message}`));
  result.errors.forEach((message) => console.error(message));
  console.log(`i18n: ${result.errors.length} erreur(s), ${result.warnings.length} avertissement(s)`);
  process.exitCode = result.errors.length ? 1 : 0;
}
