import { memo, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import './CentralPanel.css';
import './RootEditor.css';

export const RootEditor = memo(function RootEditor({ node, projectType, onUpdateRoot, onUpdateMedia, onUpdateStoryAudio }) {
  const sameImage = !!node.sameImage;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;

  function setSameImage(v) {
    onUpdateMedia('sameImage', v);
    if (v && node.rootImage) onUpdateMedia('thumbnailImage', node.rootImage);
  }

  const [textImgModal, setTextImgModal] = useState(null);

  function handleGenerateTextImage() {
    setTextImgModal({
      defaultText: node.name || '',
      onConfirm: (path) => {
        onUpdateMedia('rootImage', path);
        if (sameImage) onUpdateMedia('thumbnailImage', path);
        onUpdateMedia('autoGenerateRootImage', false);
      },
    });
  }

  function handleGenerateThumbnailTextImage() {
    setTextImgModal({
      defaultText: node.name || '',
      onConfirm: (path) => {
        onUpdateMedia('thumbnailImage', path);
        onUpdateMedia('autoGenerateRootImage', false);
      },
    });
  }

  function renderImageModeControl() {
    return (
      <div className="root-image-mode" role="group" aria-label="Mode des images de couverture">
        <button
          type="button"
          className={`root-image-mode-btn ${sameImage ? 'is-active' : ''}`}
          aria-pressed={sameImage}
          onClick={() => setSameImage(true)}
        >
          Même image
        </button>
        <button
          type="button"
          className={`root-image-mode-btn ${!sameImage ? 'is-active' : ''}`}
          aria-pressed={!sameImage}
          onClick={() => setSameImage(false)}
        >
          Images séparées
        </button>
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
            Ce pack utilise une structure interactive avec convergences et retours Home explicites. Les stages ci-dessous sont ceux qui seront utilisés pour le round-trip fidèle.
          </div>
          <NativeGraphEditor
            graph={nativeGraph}
            onChange={(nextGraph) => onUpdateMedia('nativeGraph', nextGraph)}
          />
        </div>
      ) : null}

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Menu Racine</div>
          <div className="card-copy card-copy--inline">Visible dans le menu principal quand on parcourt les histoires</div>
        </div>

        {projectType === 'pack' ? (
          <>
            <div className="field-row" style={{ marginBottom: 0 }}>
              <span className="field-label">Nom</span>
              <input
                className="field-input"
                value={node.rootName ?? ''}
                onChange={(e) => onUpdateRoot({ rootName: e.target.value })}
                placeholder="Menu racine"
              />
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                {node.rootEntries?.length ?? 0} élément(s)
              </span>
            </div>
            <div className="card-sep" />
          </>
        ) : null}

        <div className="root-image-heading">
          <div className="media-col-header">
            Image
            <span className="media-col-subtitle">Couverture du pack (320×240)</span>
          </div>
          {renderImageModeControl()}
        </div>

        {sameImage ? (
          <div className="media-split">
            <div className="media-split-left">
              <ImageField
                compact
                accentLabel
                fieldId="root:coverImage"
                file={node.rootImage}
                extraActions={[
                  {
                    key: 'generate-text',
                    label: 'Générer un texte',
                    icon: '✦',
                    onClick: handleGenerateTextImage,
                    title: "Créer une image texte à partir du nom de l'histoire",
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
              <div className="media-col-header">
                Son
                <span className="media-col-subtitle">Titre audio — entendu dans le menu principal</span>
              </div>
              <AudioField
                accentLabel
                label="Titre audio"
                description="Entendu dans le menu principal"
                file={node.rootAudio}
                ttsTextSuggestion={node.name || ''}
                ttsFilenameHint={`titre-${node.name || 'projet'}`}
                xttsTarget={{ kind: 'root', field: 'rootAudio' }}
                onPick={(f) => onUpdateMedia('rootAudio', f)}
                onClear={() => onUpdateMedia('rootAudio', null)}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="images-side-by-side">
              <div className="root-image-col">
                <div className="root-image-sublabel">Boîte à Histoires</div>
                <ImageField
                  align="start"
                  accentLabel
                  fieldId="root:rootImage"
                  file={node.rootImage}
                  extraActions={[
                    {
                      key: 'generate-text',
                      label: 'Générer un texte',
                      icon: '✦',
                      onClick: handleGenerateTextImage,
                      title: "Créer une image texte à partir du nom de l'histoire",
                    },
                  ]}
                  onPick={(f) => { onUpdateMedia('rootImage', f); onUpdateMedia('autoGenerateRootImage', false); }}
                  onClear={() => { onUpdateMedia('rootImage', null); onUpdateMedia('autoGenerateRootImage', false); }}
                />
              </div>
              <div className="root-image-col">
                <div className="root-image-sublabel">STUdio / LuniiQt</div>
                <ImageField
                  align="start"
                  accentLabel
                  fieldId="root:thumbnailImage"
                  file={node.thumbnailImage}
                  extraActions={[
                    {
                      key: 'generate-text',
                      label: 'Générer un texte',
                      icon: '✦',
                      onClick: handleGenerateThumbnailTextImage,
                      title: "Créer une image texte pour la bibliothèque à partir du nom de l'histoire",
                    },
                  ]}
                  onPick={(f) => onUpdateMedia('thumbnailImage', f)}
                  onClear={() => onUpdateMedia('thumbnailImage', null)}
                />
              </div>
            </div>
            <div style={{ marginTop: 20 }}>
              <div className="media-col-header">
                Son
                <span className="media-col-subtitle">Titre audio — entendu dans le menu principal</span>
              </div>
              <AudioField
                label="Titre audio"
                description="Entendu dans le menu principal"
                file={node.rootAudio}
                ttsTextSuggestion={node.name || ''}
                ttsFilenameHint={`titre-${node.name || 'projet'}`}
                xttsTarget={{ kind: 'root', field: 'rootAudio' }}
                onPick={(f) => onUpdateMedia('rootAudio', f)}
                onClear={() => onUpdateMedia('rootAudio', null)}
              />
            </div>
          </>
        )}
      </div>

      {projectType === 'simple' && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Histoire complète</div>
            <div className="card-copy card-copy--inline">Écoutée quand l'enfant valide son choix</div>
          </div>
          <AudioField
            label="Histoire complète"
            description="Écoutée quand l'enfant valide son choix"
            file={node.storyAudio}
            ttsFilenameHint={`histoire-complete-${node.name || 'histoire'}`}
            xttsTarget={{ kind: 'rootStory', field: 'audio' }}
            onPick={(f) => {
              const autoName = f.split(/[\\/]/).pop()
                .replace(/\.(mp3|ogg|wav|m4a)$/i, '')
                .replace(/[-_]/g, ' ').trim();
              onUpdateStoryAudio(f);
              if (!node.name) onUpdateRoot({ name: autoName });
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
