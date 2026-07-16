import { memo, useEffect, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { Toggle } from '../common/Toggle';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { Info } from '../icons/LucideLocal';
import { KEYS, read, write } from '../../store/persistentSettings';
import { basename } from '../../utils/fileUtils';
import './CentralPanel.css';
import './RootEditor.css';

export const RootEditor = memo(function RootEditor({ node, projectType, onUpdateRoot, onUpdateMedia, onUpdateStoryAudio }) {
  const sameImage = !!node.sameImage;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;
  const isSimple = projectType === 'simple';
  const simpleStoryName = node.packMetadata?.title || node.projectName || '';
  const rootTitle = isSimple ? simpleStoryName : (node.rootName || node.packMetadata?.title || node.projectName || '');

  const [simpleInfoDismissed, setSimpleInfoDismissed] = useState(
    () => read(KEYS.SIMPLE_MODE_INFO_DISMISS) === '1',
  );

  useEffect(() => {
    if (!isSimple) return;
    setSimpleInfoDismissed(read(KEYS.SIMPLE_MODE_INFO_DISMISS) === '1');
  }, [isSimple]);

  function dismissSimpleInfo() {
    setSimpleInfoDismissed(true);
    write(KEYS.SIMPLE_MODE_INFO_DISMISS, '1');
  }

  function handleSimpleNameChange(nextValue) {
    onUpdateRoot({ projectName: nextValue, packMetadata: { title: nextValue } });
  }

  function setSameImage(v) {
    onUpdateMedia('sameImage', v);
    if (v && node.rootImage) onUpdateMedia('thumbnailImage', node.rootImage);
  }

  const [textImgModal, setTextImgModal] = useState(null);

  function handleGenerateTextImage() {
    setTextImgModal({
      defaultText: rootTitle,
      onConfirm: (path) => {
        onUpdateMedia('rootImage', path);
        if (sameImage) onUpdateMedia('thumbnailImage', path);
        onUpdateMedia('autoGenerateRootImage', false);
      },
    });
  }

  function handleGenerateThumbnailTextImage() {
    setTextImgModal({
      defaultText: rootTitle,
      onConfirm: (path) => {
        onUpdateMedia('thumbnailImage', path);
        onUpdateMedia('autoGenerateRootImage', false);
      },
    });
  }

  function renderRootAudio() {
    return (
      <div className="root-audio-section">
        <div className="media-col-header">
          Son
          <span className="media-col-subtitle">Titre audio — entendu dans le menu principal</span>
        </div>
        <AudioField
          label="Titre audio"
          description="Entendu dans le menu principal"
          file={node.rootAudio}
          ttsTextSuggestion={rootTitle}
          ttsFilenameHint={`titre-${rootTitle || 'projet'}`}
          xttsTarget={{ kind: 'root', field: 'rootAudio' }}
          onPick={(f) => onUpdateMedia('rootAudio', f)}
          onClear={() => onUpdateMedia('rootAudio', null)}
        />
      </div>
    );
  }

  return (
    <>
      {nativeGraph ? (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Graphe interactif importé</div>
            <div className="card-copy card-copy--inline">{nativeGraphStageCount} stages · {nativeGraphActionCount} actions</div>
          </div>
          <div className="sequence-note" style={{ margin: '0 16px 12px' }}>
            Ce pack utilise une structure interactive avec convergences et retours Accueil explicites. Les stages ci-dessous sont ceux qui seront utilisés pour le round-trip fidèle.
          </div>
          <NativeGraphEditor
            graph={nativeGraph}
            onChange={(nextGraph) => onUpdateMedia('nativeGraph', nextGraph)}
          />
        </div>
      ) : null}

      {isSimple && !simpleInfoDismissed ? (
        <div className="simple-mode-info" role="note">
          <span className="simple-mode-info-icon" aria-hidden="true">
            <Info className="chrome-icon" strokeWidth={1.9} absoluteStrokeWidth />
          </span>
          <div className="simple-mode-info-text">
            <strong>Mode histoire simple</strong>
            <span>
              Tu crées un pack contenant une seule histoire. Pour des menus, plusieurs histoires ou
              une navigation personnalisée, utilise plutôt l'« Éditeur libre ».
            </span>
          </div>
          <button
            type="button"
            className="simple-mode-info-dismiss"
            onClick={dismissSimpleInfo}
            aria-label="Masquer ce message"
            title="Masquer ce message"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="card root-identity-card">
        <div className="card-title-row">
          <div className="card-title">{isSimple ? 'Mon histoire' : 'Menu Racine'}</div>
          <div className="card-copy card-copy--inline">
            {isSimple
              ? "Image et audio utilisés quand l'enfant choisit cette histoire."
              : "Image et audio utilisés quand l'enfant choisit ce pack."}
          </div>
        </div>

        {projectType === 'pack' ? (
          <div className="root-card-name-row root-card-name-row--identity">
            <div className="field-row" style={{ marginBottom: 0, flex: 1 }}>
              <span className="field-label">Nom</span>
              <input
                className="field-input"
                value={node.rootName ?? ''}
                onChange={(e) => onUpdateRoot({ rootName: e.target.value })}
                placeholder="Menu racine"
              />
            </div>
            <span className="root-entry-count">
              {node.rootEntries?.length ?? 0} élément(s)
            </span>
          </div>
        ) : null}

        {isSimple ? (
          <div className="root-card-name-row root-card-name-row--simple root-card-name-row--identity">
            <div className="simple-name-field">
              <label className="simple-name-label" htmlFor="root-simple-name">Nom de l'histoire</label>
              <input
                id="root-simple-name"
                className="field-input simple-name-input"
                value={simpleStoryName}
                onChange={(e) => handleSimpleNameChange(e.target.value)}
                placeholder="Le loup et l'agneau"
              />
              <span className="simple-name-hint">Apparaît dans le catalogue Lunii et donne son nom au fichier ZIP exporté.</span>
            </div>
          </div>
        ) : null}

        <div className="card-sep" />

        <div className="root-media-section">
          {sameImage ? (
            <div className="media-split root-cover-media-split">
              <div className="media-split-left">
                <div className="media-col-header">
                  Image
                  <span className="media-col-subtitle">
                    {isSimple
                      ? "Visuel utilisé pour présenter l'histoire"
                      : 'Visuel utilisé pour présenter le pack'}
                  </span>
                </div>
                <ImageField
                  fieldId="root:coverImage"
                  file={node.rootImage}
                  badge="Lunii + Catalogue"
                  formatHint="Choisis une image : elle sera adaptée en 320 × 240 px à l’export"
                  extraActions={[
                    {
                      key: 'generate-text',
                      label: 'Générer une image-titre',
                      icon: '✦',
                      onClick: handleGenerateTextImage,
                      title: "Créer une image-titre à partir du nom de l'histoire",
                    },
                  ]}
                  onPick={(f) => {
                    onUpdateMedia('rootImage', f);
                    onUpdateMedia('thumbnailImage', f);
                    onUpdateMedia('autoGenerateRootImage', false);
                  }}
                  onClear={() => {
                    onUpdateMedia('rootImage', null);
                    onUpdateMedia('thumbnailImage', null);
                    onUpdateMedia('autoGenerateRootImage', false);
                  }}
                />
              </div>
              <div className="media-split-divider" />
              <div className="media-split-right">
                {renderRootAudio()}
              </div>
            </div>
          ) : (
            <>
              <div className="root-image-section">
                <div className="media-col-header">
                  Image
                  <span className="media-col-subtitle">
                    {isSimple
                      ? "Visuels utilisés pour présenter l'histoire sur la Lunii et dans les catalogues"
                      : 'Visuels utilisés pour présenter le pack sur la Lunii et dans les catalogues'}
                  </span>
                </div>
                <div className="root-image-split-layout">
                  <div className="root-image-col root-image-col--lunii">
                    <div className="media-col-header">
                      Image Lunii
                      <span className="media-col-subtitle">Affichée sur la Lunii, adaptée en 320×240 à l'export</span>
                    </div>
                    <ImageField
                      align="start"
                      fieldId="root:rootImage"
                      file={node.rootImage}
                      badge="Lunii · 320×240"
                      formatHint="Choisis une image : elle sera adaptée en 320 × 240 px à l’export"
                      extraActions={[
                        {
                          key: 'generate-text',
                          label: 'Générer une image-titre',
                          icon: '✦',
                          onClick: handleGenerateTextImage,
                          title: "Créer une image-titre à partir du nom de l'histoire",
                        },
                      ]}
                      onPick={(f) => { onUpdateMedia('rootImage', f); onUpdateMedia('autoGenerateRootImage', false); }}
                      onClear={() => { onUpdateMedia('rootImage', null); onUpdateMedia('autoGenerateRootImage', false); }}
                    />
                  </div>
                  <div className="root-image-col root-image-col--catalog">
                    <div className="media-col-header">
                      Vignette catalogue
                      <span className="media-col-subtitle">Utilisée par STUdio, LuniiQt et les bibliothèques</span>
                    </div>
                    <ImageField
                      align="start"
                      fieldId="root:thumbnailImage"
                      file={node.thumbnailImage}
                      badge="Catalogue · taille libre"
                      formatHint="Taille libre — utilisée par STUdio, LuniiQt et les catalogues"
                      extraActions={[
                        {
                          key: 'generate-text',
                          label: 'Générer une image-titre',
                          icon: '✦',
                          onClick: handleGenerateThumbnailTextImage,
                          title: "Créer une image-titre pour le catalogue à partir du nom de l'histoire",
                        },
                      ]}
                      onPick={(f) => onUpdateMedia('thumbnailImage', f)}
                      onClear={() => onUpdateMedia('thumbnailImage', null)}
                    />
                  </div>
                </div>
              </div>
              <div className="card-sep" />
              <div className="root-audio-below">
                {renderRootAudio()}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card root-image-settings-card">
        <div className="card-title-row">
          <div className="card-title">Réglage du menu racine</div>
        </div>

        <label className="sequence-control root-image-sync-control">
          <Toggle
            on={sameImage}
            onChange={setSameImage}
            ariaLabel="Utiliser la même image pour la Lunii et la vignette catalogue"
          />
          <div className="root-image-sync-copy">
            <span className="during-play-control-title">
              Utiliser la même image pour la Lunii et la vignette catalogue
            </span>
          </div>
        </label>
      </div>

      {isSimple && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Récit complet</div>
            <div className="card-copy card-copy--inline">Le fichier audio joué quand l'enfant valide son choix sur la Lunii — c'est l'histoire en elle-même.</div>
          </div>
          <AudioField
            label="Audio du récit"
            description="Joué quand l'enfant valide son choix"
            file={node.storyAudio}
            ttsFilenameHint={`histoire-complete-${simpleStoryName || 'histoire'}`}
            xttsTarget={{ kind: 'rootStory', field: 'audio' }}
            onPick={(f) => {
              const autoName = basename(f)
                .replace(/\.(mp3|ogg|wav|m4a)$/i, '')
                .replace(/[-_]/g, ' ').trim();
              onUpdateStoryAudio(f);
              if (!simpleStoryName && autoName) handleSimpleNameChange(autoName);
            }}
            onClear={() => onUpdateStoryAudio(null)}
          />
        </div>
      )}

      {textImgModal && (
        <TextImagePromptModal
          defaultText={textImgModal.defaultText}
          onConfirm={(path) => { textImgModal.onConfirm(path); setTextImgModal(null); }}
          onCancel={() => setTextImgModal(null)}
        />
      )}
    </>
  );
});
