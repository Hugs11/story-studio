import { lazy } from 'react';
import { renderDeferred } from './renderDeferred';
import { SaveProgressModal } from './common/SaveProgressModal';
import { GenerateProgressModal } from './GenerateModal/GenerateProgressModal';
import { ImportNoticeToast } from './common/ImportNoticeToast';
import { CreditsModal } from './common/CreditsModal';
import { SessionMediaTriageModal } from './SessionMediaTriage/SessionMediaTriageModal';

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
  // état payload (pas un simple booléen de disclosure)
  youtubeFunnelMode,
  setYoutubeFunnelMode,
  toolbarTtsTargetMenuId,
  // contexte
  project,
  savePath,
  projectType,
  workspaceDir,
  projectName,
  appVersion,
  xttsSettings,
  canGenerate,
  canGenerateStoryTts,
  modalExportFolder,
  importedPackPendingMetaRef,
  optionsTabProps,
  // génération IA
  sdGenerate,
  onSDGenerate,
  onQueueXttsGenerate,
  onUpdateXttsSettings,
  // génération pack
  packMetadata,
  onSavePackMetadata,
  // cycle de vie projet
  onLandEditablePack,
  onSimulatePackReady,
  // import média
  onImportMediaEpisodes,
  onPodcastFunnelImport,
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
  return (
    <>
      {modals.isOpen('prefs') && renderDeferred(
        <OptionsTab
          {...optionsTabProps}
          asModal
          onClose={() => modals.close('prefs')}
        />,
      )}

      {modals.isOpen('record') && renderDeferred(
        <RecordModal
          savePath={savePath}
          workspaceDir={workspaceDir}
          projectName={projectName}
          onSaved={onToolbarRecordSaved}
          onClose={() => modals.close('record')}
        />
      )}

      {modals.isOpen('tts') && canGenerateStoryTts && renderDeferred(
        <GenerateVoiceModal
          savePath={savePath}
          xttsSettings={xttsSettings}
          label="Nouvelle histoire"
          initialText=""
          filenameHint="histoire-tts"
          target={{ kind: 'newStory', menuId: toolbarTtsTargetMenuId }}
          onUpdateXttsSettings={onUpdateXttsSettings}
          onQueueGenerate={onQueueXttsGenerate}
          onClose={() => modals.close('tts')}
        />,
      )}

      {modals.isOpen('podcastImport') && renderDeferred(
        <PodcastImportModal
          onImport={(episodes, feed) => onImportMediaEpisodes(episodes, feed)}
          onClose={() => modals.close('podcastImport')}
        />,
      )}

      {modals.isOpen('editPack') && renderDeferred(
        <EditPackFunnel
          onClose={() => modals.close('editPack')}
          onLand={onLandEditablePack}
          onSimulate={onSimulatePackReady}
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
          onClose={() => setYoutubeFunnelMode(null)}
          onImport={youtubeFunnelMode === 'editor' ? onYoutubeEditorImport : onYoutubeFunnelImport}
        />
      )}

      {modals.isOpen('aggregatePacks') && renderDeferred(
        <AggregatePacksFunnel
          onClose={() => modals.close('aggregatePacks')}
        />
      )}

      {modals.isOpen('packChecker') && renderDeferred(
        <CommunityPackCheckerFunnel
          onClose={() => modals.close('packChecker')}
        />
      )}

      {packMetadata.open && renderDeferred(
        <PackNameModal
          open={packMetadata.open}
          packMetadata={{
            ...(project.packMetadata ?? {}),
            // Titre pré-rempli si vide : nom du menu racine (pack) puis nom du
            // projet, en cohérence avec le titre affiché dans RootEditor.
            title: project.packMetadata?.title
              || (projectType === 'pack' ? project.rootName : '')
              || project.projectName
              || '',
          }}
          project={project}
          coverImage={project.thumbnailImage || project.rootImage}
          exportFolder={modalExportFolder}
          generateDisabled={!canGenerate}
          promptRegenerateUuid={importedPackPendingMetaRef.current}
          onSave={(draft) => onSavePackMetadata(draft, { generate: false })}
          onSaveAndGenerate={(draft) => onSavePackMetadata(draft, { generate: true })}
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

      {saveAsProgress && <SaveProgressModal data={saveAsProgress} title="Enregistrement sous..." doneTitle="Copie terminée" />}
      {saveProgress && <SaveProgressModal data={saveProgress} title="Enregistrement..." doneTitle="Projet enregistré" />}
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
        <GenerateProgressModal title="Extraction en cours...">
          <div className="gen-progress-name">{unpacking.name}</div>
          <div className="gen-progress-desc">
            Story Studio analyse le pack et extrait les éléments éditables.
          </div>
        </GenerateProgressModal>
      )}

      {importing && (
        <GenerateProgressModal title="Import en cours...">
          <div className="gen-progress-name">{importing.name}</div>
          <div className="gen-progress-desc">{importing.phase}</div>
          <div className="gen-progress-meta">
            {importing.total > 1 ? `Fichier ${Math.max(importing.index, 1)} sur ${importing.total}` : 'Traitement du fichier importé'}
          </div>
        </GenerateProgressModal>
      )}

      {importNotice && (
        <ImportNoticeToast message={importNotice} onClose={() => setImportNotice(null)} />
      )}

      {/* Credits modal */}
      {modals.isOpen('credits') && (
        <CreditsModal appVersion={appVersion} onClose={() => modals.close('credits')} />
      )}
    </>
  );
}
