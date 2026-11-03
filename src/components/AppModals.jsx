import { useCommonTranslation } from '../i18n/commonPresentation.js';
import { lazy } from 'react';
import { renderDeferred } from './renderDeferred';
import { SaveProgressModal } from './common/SaveProgressModal';
import { GenerateProgressModal } from './GenerateModal/GenerateProgressModal';
import { ImportNoticeToast } from './common/ImportNoticeToast';
import { CreditsModal } from './common/CreditsModal';
import { SessionMediaTriageModal } from './SessionMediaTriage/SessionMediaTriageModal';
import { isAdvancedProject } from '../store/projectModel/envelope';
import { suggestedPackTitle } from '../store/packMetadataModel';
import { ReleaseNotesModal } from './common/ReleaseNotesModal';

const OptionsTab = lazy(() => import('../tabs/OptionsTab').then((module) => ({ default: module.OptionsTab })));
const AggregatePacksFunnel = lazy(() => import('./AggregatePacks/AggregatePacksFunnel')
  .then((module) => ({ default: module.AggregatePacksFunnel })));
const CommunityPackCheckerFunnel = lazy(() => import('./CommunityPackChecker/CommunityPackCheckerFunnel')
  .then((module) => ({ default: module.CommunityPackCheckerFunnel })));
const EditPackFunnel = lazy(() => import('./EditPack/EditPackFunnel')
  .then((module) => ({ default: module.EditPackFunnel })));
const PodcastImportFunnel = lazy(() => import('./PodcastImport/PodcastImportFunnel')
  .then((module) => ({ default: module.PodcastImportFunnel })));
const YoutubeImportFunnel = lazy(() => import('./YoutubeImport/YoutubeImportFunnel')
  .then((module) => ({ default: module.YoutubeImportFunnel })));
const SDGenerateModal = lazy(() => import('./SDGenerateModal/SDGenerateModal').then((module) => ({ default: module.SDGenerateModal })));
const RecordModal = lazy(() => import('./RecordModal/RecordModal').then((module) => ({ default: module.RecordModal })));
const GenerateVoiceModal = lazy(() => import('./GenerateVoiceModal/GenerateVoiceModal')
  .then((module) => ({ default: module.GenerateVoiceModal })));
const PackNameModal = lazy(() => import('./layout/PackNameModal').then((module) => ({ default: module.PackNameModal })));
const MissingMediaRelinkModal = lazy(() => import('./MissingMediaRelink/MissingMediaRelinkModal')
  .then((module) => ({ default: module.MissingMediaRelinkModal })));
const PodcastImportModal = lazy(() => import('./PodcastImport/PodcastImportModal')
  .then((module) => ({ default: module.PodcastImportModal })));

// Mur de modales/overlays d'AppContent. Composant présentational pur : aucune
// logique, seulement du rendu conditionnel et du
// branchement de props. Chaque overlay reste sous sa garde `open &&` /
// `renderDeferred(...)` et conserve le code-split (imports lazy).
//
// Trois familles :
//  - piloté par disclosure (booléen dans `modals`),
//  - piloté par une donnée (funnel mode, requêtes de sauvegarde/tri/import…),
//  - contexte lecture seule (project, savePath, réglages…).
export function AppModals({
  modals,
  subscriptionImportSource,
  onSubscriptionImportClosed,
  // état payload (pas un simple booléen de disclosure)
  youtubeFunnelMode,
  setYoutubeFunnelMode,
  toolbarTtsTarget,
  // contexte
  project,
  savePath,
  workspaceDir,
  projectName,
  appVersion,
  xttsSettings,
  canGenerate,
  canGenerateStoryTts,
  modalExportFolder,
  importedPackPendingMetaRef,
  optionsTabProps,
  preferencesSection = optionsTabProps?.initialSection ?? null,
  // génération IA
  sdGenerate,
  onSDGenerate,
  onQueueXttsGenerate,
  onUpdateXttsSettings,
  // génération pack
  packMetadata,
  onSavePackMetadata,
  // Fiche du pack côté graphe : brouillon lu dans le document, gouvernance des
  // champs, compteurs de la structure, et son propre chemin d'écriture — un
  // geste d'auteur annulable, jamais une pose dans l'enveloppe du projet.
  advancedMetadataForm = null,
  onSaveAdvancedPackMetadata = null,
  // cycle de vie projet
  onLandAggregate,
  onLandEditablePack,
  onLandAdvancedPack,
  onBeforeReplacePack,
  onSimulatePackReady,
  // import média
  onPodcastFunnelImport,
  onPodcastEditorImport,
  onYoutubeFunnelImport,
  onYoutubeEditorImport,
  importing,
  unpacking,
  // relink média manquant
  showMissingMediaRelink,
  missingMedia,
  missingMediaSignature,
  onApplyMissingMediaRelinks,
  setDismissedMissingMediaSignature,
  // cycle de sauvegarde + tri média de session
  saveProgress,
  saveAsProgress,
  triageRequest,
  // toast + enregistrement
  importNotice,
  setImportNotice,
  onToolbarRecordSaved,
}) {
  const { t } = useCommonTranslation();
  // Le mode du projet, lu à sa source unique. Il décide de l'aiguillage de la
  // fiche du pack, y compris avant que le document de graphe ait été lu une
  // première fois.
  const graphProject = isAdvancedProject(project);

  return (
    <>
      {appVersion && <ReleaseNotesModal key={appVersion} appVersion={appVersion} forceOpen={modals.isOpen('releaseNotes')} onClose={() => modals.close('releaseNotes')} />}
      {modals.isOpen('prefs') && renderDeferred(
        <OptionsTab
          {...optionsTabProps}
          asModal
          initialSection={preferencesSection}
          onClose={() => { optionsTabProps.onPreferencesClosed?.(); modals.close('prefs'); }}
        />,
      )}

      {modals.isOpen('record') && renderDeferred(
        <RecordModal
          workspaceDir={workspaceDir}
          projectName={projectName}
          onSaved={onToolbarRecordSaved}
          onClose={() => modals.close('record')}
        />
      )}

      {/* La cible du texte lu est décidée par l'hôte, qui seul sait quel
          éditeur est ouvert. Une nouvelle histoire dans le dossier visé côté
          Libre ; côté graphe, la bibliothèque de médias et rien d'autre. */}
      {modals.isOpen('tts') && canGenerateStoryTts && renderDeferred(
        <GenerateVoiceModal
          savePath={savePath}
          xttsSettings={xttsSettings}
          label={t('common:appModals.tts.label')}
          labelRef={{ key: 'common:appModals.tts.label' }}
          initialText=""
          filenameHint="histoire-tts"
          target={toolbarTtsTarget}
          onUpdateXttsSettings={onUpdateXttsSettings}
          onQueueGenerate={onQueueXttsGenerate}
          onClose={() => modals.close('tts')}
        />,
      )}

      {modals.isOpen('podcastImport') && renderDeferred(
        <PodcastImportModal
          onImport={onPodcastEditorImport}
          initialSource={subscriptionImportSource?.source === 'podcast' ? subscriptionImportSource : null}
          onClose={() => { modals.close('podcastImport'); onSubscriptionImportClosed?.(); }}
          toLibrary={graphProject}
        />,
      )}

      {modals.isOpen('editPack') && renderDeferred(
        <EditPackFunnel
          onClose={() => modals.close('editPack')}
          onLand={onLandEditablePack}
          onSimulate={onSimulatePackReady}
          onLandAdvanced={onLandAdvancedPack}
          onBeforeReplace={onBeforeReplacePack}
          openedFromGraph={graphProject}
          onNotice={setImportNotice}
        />
      )}

      {modals.isOpen('podcastFunnel') && renderDeferred(
        <PodcastImportFunnel
          onClose={() => modals.close('podcastFunnel')}
          onImport={onPodcastFunnelImport}
        />
      )}

      {youtubeFunnelMode && renderDeferred(
        <YoutubeImportFunnel
          mode={youtubeFunnelMode}
          toLibrary={youtubeFunnelMode === 'editor' && graphProject}
          initialSource={subscriptionImportSource?.source === 'youtube' ? subscriptionImportSource : null}
          onClose={() => { setYoutubeFunnelMode(null); onSubscriptionImportClosed?.(); }}
          onImport={youtubeFunnelMode === 'editor' ? onYoutubeEditorImport : onYoutubeFunnelImport}
        />
      )}

      {modals.isOpen('aggregatePacks') && renderDeferred(
        <AggregatePacksFunnel
          onLand={onLandAggregate}
          onClose={() => modals.close('aggregatePacks')}
        />
      )}

      {modals.isOpen('packChecker') && renderDeferred(
        <CommunityPackCheckerFunnel
          onClose={() => modals.close('packChecker')}
        />
      )}

      {/* La fiche du pack, première étape du parcours de fabrication des deux
          côtés. `canGenerate` qualifie l'arbre ; côté graphe, ce qui
          bloque est recalculé au départ de la production sur le payload
          courant, et un verdict mémorisé ici en ferait un second.

          L'aiguillage lit le **mode du projet**, pas la présence du formulaire
          avancé : celui-ci attend la première lecture du document, et pendant
          ce court instant confier un projet graphe à la chaîne Libre lui ferait
          traverser un normaliseur qui le refuse. */}
      {packMetadata.open && renderDeferred(
        <PackNameModal
          open={packMetadata.open}
          packMetadata={{
            ...(project.packMetadata ?? {}),
            title: suggestedPackTitle(project),
          }}
          advanced={advancedMetadataForm}
          project={project}
          // `rootImage` est un média d'arbre : il n'existe pas dans un projet
          // graphe, où la couverture est soit la vignette d'enveloppe, soit —
          // à défaut — l'image de l'Écran d'entrée que le moteur reprend seul.
          coverImage={advancedMetadataForm
            ? advancedMetadataForm.coverImage
            : (project.thumbnailImage || project.rootImage)}
          // La vignette catalogue se choisit ici, et nulle part ailleurs : sans
          // image propre, elle reprend l'image racine.
          catalogImage={advancedMetadataForm
            ? advancedMetadataForm.catalogImage
            : (project.sameImage ? null : (project.thumbnailImage ?? null))}
          fallbackImage={advancedMetadataForm
            ? advancedMetadataForm.fallbackImage
            : (project.rootImage ?? null)}
          exportFolder={modalExportFolder}
          generateDisabled={graphProject ? false : !canGenerate}
          promptRegenerateUuid={importedPackPendingMetaRef.current}
          onSave={graphProject
            ? onSaveAdvancedPackMetadata
            : (draft) => onSavePackMetadata(draft, { generate: false })}
          onSaveAndGenerate={graphProject
            ? (draft) => onSaveAdvancedPackMetadata(draft, { generate: true })
            : (draft) => onSavePackMetadata(draft, { generate: true })}
          onClose={packMetadata.close}
        />,
      )}

      {/* SD — modale de génération */}
      {sdGenerate.open && renderDeferred(
        <SDGenerateModal
          onGenerate={onSDGenerate}
          currentImagePath={sdGenerate.context?.currentImagePath ?? null}
          currentImageLabel={sdGenerate.context?.currentImageLabel ?? null}
          rootImagePath={project.rootImage ?? null}
          initialJob={sdGenerate.context?.regenerateJob ?? null}
          onClose={sdGenerate.close}
        />,
      )}

      {saveAsProgress && <SaveProgressModal data={saveAsProgress} title={t('common:appModals.saveAs.progress')} doneTitle={t('common:appModals.saveAs.done')} />}
      {saveProgress && <SaveProgressModal data={saveProgress} title={t('common:appModals.save.progress')} doneTitle={t('common:titleBar.save.saved')} />}
      {triageRequest && (
        <SessionMediaTriageModal items={triageRequest.items} onResolve={triageRequest.resolve} />
      )}
      {showMissingMediaRelink && renderDeferred(
        <MissingMediaRelinkModal
          missingMedia={missingMedia}
          workspaceDir={workspaceDir}
          onApply={onApplyMissingMediaRelinks}
          onClose={() => setDismissedMissingMediaSignature(missingMediaSignature)}
        />,
      )}

      {unpacking && (
        <GenerateProgressModal title={t('common:appModals.extraction.title')}>
          <div className="gen-progress-name">{unpacking.name}</div>
          <div className="gen-progress-desc">{t('common:appModals.extraction.description')}</div>
        </GenerateProgressModal>
      )}

      {importing && (
        <GenerateProgressModal title={t('common:appModals.import.title')}>
          <div className="gen-progress-name">{importing.name}</div>
          <div className="gen-progress-desc">{importing.phase}</div>
          <div className="gen-progress-meta">
            {importing.total > 1 ? t('common:appModals.import.position', { index: Math.max(importing.index, 1), total: importing.total }) : t('common:appModals.import.single')}
          </div>
        </GenerateProgressModal>
      )}

      {importNotice && (
        <ImportNoticeToast message={importNotice} onClose={() => setImportNotice(null)} />
      )}

      {/* Credits modal */}
      {modals.isOpen('credits') && (
        <CreditsModal appVersion={appVersion} onClose={() => modals.close('credits')} onOpenReleaseNotes={appVersion ? () => { modals.close('credits'); modals.open('releaseNotes'); } : null} />
      )}
    </>
  );
}
