import { memo, useEffect, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { Image as ImageIcon, Info } from '../icons/LucideLocal';
import './CentralPanel.css';
import './RootEditor.css';

const SIMPLE_MODE_INFO_DISMISS_KEY = 'storyStudio.simpleModeInfoDismissed';

export const RootEditor = memo(function RootEditor({ node, projectType, onUpdateRoot, onUpdateMedia, onUpdateStoryAudio }) {
  const sameImage = !!node.sameImage;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;
  const isSimple = projectType === 'simple';
  const simpleStoryName = node.packMetadata?.title || node.projectName || '';
  const rootTitle = isSimple ? simpleStoryName : (node.packMetadata?.title || node.projectName || '');

  const [simpleInfoDismissed, setSimpleInfoDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem(SIMPLE_MODE_INFO_DISMISS_KEY) === '1'; }
    catch { return false; }
  });

  useEffect(() => {
    if (!isSimple) return;
    if (typeof window === 'undefined') return;
    try {
      setSimpleInfoDismissed(window.localStorage.getItem(SIMPLE_MODE_INFO_DISMISS_KEY) === '1');
    } catch { /* ignore */ }
  }, [isSimple]);

  function dismissSimpleInfo() {
    setSimpleInfoDismissed(true);
    try { window.localStorage.setItem(SIMPLE_MODE_INFO_DISMISS_KEY, '1'); }
    catch { /* ignore */ }
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

  function renderImageModeControl() {
    return (
      <div className="root-image-mode" role="group" aria-label="Mode des images de couverture">
        <button
          type="button"
          className={`root-image-mode-btn ${sameImage ? 'is-active' : ''}`}
          aria-pressed={sameImage}
          onClick={() => setSameImage(true)}
        >
          <ImageIcon className="root-image-mode-icon" strokeWidth={2} absoluteStrokeWidth />
          Même image
        </button>
        <button
          type="button"
          className={`root-image-mode-btn ${!sameImage ? 'is-active' : ''}`}
          aria-pressed={!sameImage}
          onClick={() => setSameImage(false)}
        >
          <span className="root-image-mode-double" aria-hidden="true">
            <ImageIcon className="root-image-mode-icon" strokeWidth={2} absoluteStrokeWidth />
            <ImageIcon className="root-image-mode-icon" strokeWidth={2} absoluteStrokeWidth />
          </span>
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
              une navigation personnalisée, utilise plutôt le mode « Créer un pack d'histoires ».
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

      <div className="card root-card">
        <div className="card-title-row">
          <div className="card-title">{isSimple ? 'Mon histoire' : 'Menu Racine'}</div>
          <div className="card-copy card-copy--inline">
            {isSimple
              ? "Voici la fiche de ton histoire dans le catalogue Lunii : son nom, l'image et l'audio entendus quand l'enfant fait tourner la molette et s'arrête sur ton histoire."
              : "Couverture du pack sur la Lunii — image et audio entendus quand l'enfant fait tourner la molette entre ses différents packs et qu'il s'arrête sur celui-ci."}
          </div>
        </div>

        {projectType === 'pack' ? (
          <div className="root-card-name-row">
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
          <div className="root-card-name-row root-card-name-row--simple">
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

        <div className="root-media-section">
          <div className="root-image-heading">
            <div className="media-col-header">
              Image
              <span className="media-col-subtitle">
                {sameImage
                  ? 'Cette image sert à la Lunii et à la vignette catalogue. À l’export, la version Lunii est adaptée en 320×240.'
                  : 'Image affichée sur la Lunii. À l’export, elle est adaptée en 320×240. La vignette catalogue garde sa taille d’origine.'}
              </span>
            </div>
            {renderImageModeControl()}
          </div>

          {sameImage ? (
            <div className="root-image-grid root-image-grid--single">
              <ImageField
                compact
                accentLabel
                fieldId="root:coverImage"
                file={node.rootImage}
                badge="Lunii + Catalogue"
                formatHint="Choisis une image : elle sera adaptée en 320 × 240 px à l’export"
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
          ) : (
            <div className="root-image-grid root-image-grid--split">
              <div className="root-image-col">
                <div className="root-image-sublabel">Écran Lunii (320×240)</div>
                <ImageField
                  align="start"
                  accentLabel
                  fieldId="root:rootImage"
                  file={node.rootImage}
                  badge="Lunii · 320×240"
                  formatHint="Choisis une image : elle sera adaptée en 320 × 240 px à l’export"
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
                <div className="root-image-sublabel">Vignette catalogue</div>
                <ImageField
                  align="start"
                  accentLabel
                  fieldId="root:thumbnailImage"
                  file={node.thumbnailImage}
                  badge="Catalogue · taille libre"
                  formatHint="Taille libre — utilisée par STUdio, LuniiQt et les catalogues"
                  extraActions={[
                    {
                      key: 'generate-text',
                      label: 'Générer un texte',
                      icon: '✦',
                      onClick: handleGenerateThumbnailTextImage,
                      title: "Créer une image texte pour le catalogue à partir du nom de l'histoire",
                    },
                  ]}
                  onPick={(f) => onUpdateMedia('thumbnailImage', f)}
                  onClear={() => onUpdateMedia('thumbnailImage', null)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="root-card-divider" />

        <div className="root-audio-section">
          <div className="media-col-header">
            Son
            <span className="media-col-subtitle">Titre audio — entendu dans le menu principal</span>
          </div>
          <AudioField
            accentLabel
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
              const autoName = f.split(/[\\/]/).pop()
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
