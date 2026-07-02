import { memo, useMemo, useState } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { findEntryById } from '../../store/projectModel';
import { useProjectContext } from '../../store/ProjectContext';
import { KEYS, read } from '../../store/persistentSettings';
import { isTtsAvailable, PIPER_DEFAULT_VOICE } from '../../store/xttsSettings';
import { useErrorDialog } from '../common/Dialog';
import { generateTextImage } from '../TextImageGenerator/generateTextImage';
import { CircleStop, Moon, Pause, Sparkles, Speech, Trash2 } from '../icons/LucideLocal';
import { NavigationTargetSelect } from './story/storyUtils';
import {
  canShowTextImageBatchAction,
  getTextImageBatchTargets,
} from './multiEditorBatchTargets';
import { TREE_COLOR_PALETTE } from '../tree/treeOperations';

const STORY_DEFAULTS = { autoplay: false, pause: true, wheel: false };
const MENU_DEFAULTS = { autoplay: false, pause: false, wheel: true };

const SHARED_DURING_CONTROL_KEYS = [
  { key: 'pause',    label: 'Bouton Pause',         desc: 'Autorise la pause pendant la lecture' },
];

const MENU_CONTROL_KEYS = [
  { key: 'wheel',    label: 'Molette de sélection', desc: 'Autorise la molette pour choisir une histoire' },
  { key: 'autoplay', label: 'Lecture automatique',  desc: "Après l'audio de présentation, enchaîne automatiquement vers le contenu du dossier, sans attendre OK" },
  { key: 'pause',    label: 'Bouton pause',         desc: "Autorise la pause pendant l'audio de présentation" },
];

const STORY_AFTER_CONTROL = {
  key: 'autoplay',
  label: 'Enchaîner automatiquement',
  desc: "À la fin de l'histoire, enchaîne vers la destination de fin sans attendre.",
};

function getDefaults(type) {
  return type === 'menu' ? MENU_DEFAULTS : STORY_DEFAULTS;
}

export const MultiEditor = memo(function MultiEditor({
  selectedIds,
  project,
  projectIndex,
  allMenus,
  allStories,
  onBulkUpdateItems,
  onBulkDeleteItems,
}) {
  const ids = useMemo(() => [...selectedIds], [selectedIds]);

  const nodes = useMemo(
    () => ids.map((id) => {
      if (id === 'root') {
        return {
          id: 'root',
          type: 'root',
          name: project?.rootName || project?.packMetadata?.title || project?.projectName || 'Menu racine',
        };
      }
      if (id === 'end-node') {
        return {
          id: 'end-node',
          type: 'end-node',
          name: project?.endNodeName || 'Message de fin',
        };
      }
      return findEntryById(project, id, projectIndex);
    }).filter(Boolean),
    [ids, project, projectIndex],
  );

  const { xttsSettings, onQueueXttsGenerate, onMediaCreated, savePath } = useProjectContext();
  const { showErrorDialog } = useErrorDialog();
  const [batchImageGenerating, setBatchImageGenerating] = useState(false);
  const [batchAudioGenerating, setBatchAudioGenerating] = useState(false);
  const [batchError, setBatchError] = useState('');

  const editableNodes = nodes.filter((n) => n.type === 'story' || n.type === 'menu');
  const textImageNodes = getTextImageBatchTargets(nodes);
  const canGenerateTextImages = canShowTextImageBatchAction(nodes);
  const titleAudioNodes = nodes.filter((n) => (
    n.type === 'story'
    || n.type === 'menu'
    || n.type === 'root'
    || n.type === 'end-node'
  ));
  const editableIds = editableNodes.map((n) => n.id);
  const storyCount = nodes.filter((n) => n.type === 'story').length;
  const zipCount = nodes.filter((n) => n.type === 'zip').length;
  const menuCount = nodes.filter((n) => n.type === 'menu').length;
  const rootCount = nodes.filter((n) => n.type === 'root').length;
  const endNodeCount = nodes.filter((n) => n.type === 'end-node').length;
  const onlyStories = storyCount === nodes.length && storyCount > 0;
  const onlyMenus = menuCount === nodes.length && menuCount > 0;
  const allSameType = onlyStories || onlyMenus;
  const hasEndNode = !!project?.nightModeAudio || !!project?.globalOptions?.nightMode || !!project?.globalOptions?.endNode;

  const bannerParts = [];
  if (storyCount > 0) bannerParts.push(`${storyCount} histoire${storyCount > 1 ? 's' : ''}`);
  if (zipCount > 0) bannerParts.push(`${zipCount} ZIP`);
  if (menuCount > 0) bannerParts.push(`${menuCount} dossier${menuCount > 1 ? 's' : ''}`);
  if (rootCount > 0) bannerParts.push('menu racine');
  if (endNodeCount > 0) bannerParts.push(project?.endNodeName || 'message de fin');

  function handleControlChange(key, value) {
    onBulkUpdateItems(editableIds, (entry) => ({
      controlSettings: { ...entry.controlSettings, [key]: value },
    }));
  }

  const colorableIds = nodes
    .filter((n) => n.type === 'story' || n.type === 'menu' || n.type === 'zip')
    .map((n) => n.id);

  function getMixedColor() {
    const colors = nodes
      .filter((n) => n.type === 'story' || n.type === 'menu' || n.type === 'zip')
      .map((n) => n.treeColor ?? null);
    const unique = [...new Set(colors)];
    if (unique.length === 0) return null;
    if (unique.length === 1) return unique[0];
    return '__mixed__';
  }

  function handleSetColor(color) {
    if (colorableIds.length === 0) return;
    onBulkUpdateItems(colorableIds, () => ({ treeColor: color }));
  }

  function handleAutoBlackImageChange(value) {
    onBulkUpdateItems(
      editableNodes.filter((n) => n.type === 'menu').map((n) => n.id),
      () => ({ autoBlackImage: value }),
    );
  }

  function handleStoryAutoContinuationChange(value) {
    onBulkUpdateItems(editableIds, (entry) => ({
      controlSettings: {
        ...entry.controlSettings,
        autoplay: value,
        ok: !value,
      },
      ...(value ? {} : { returnAfterPlay: null }),
    }));
  }

  function handleNavChange(field, rawValue) {
    onBulkUpdateItems(editableIds, () => ({ [field]: rawValue || null }));
  }

  function getMixedSelectValue(field) {
    const vals = nodes.map((n) => n[field] ?? '');
    const unique = [...new Set(vals)];
    return unique.length === 1 ? unique[0] : '__mixed__';
  }

  function getMixedBooleanValue(values) {
    const unique = [...new Set(values)];
    return {
      isMixed: unique.length > 1,
      value: unique.length > 1 ? false : !!unique[0],
    };
  }

  const batchBusy = batchImageGenerating || batchAudioGenerating;
  const playbackControlKeys = onlyMenus ? MENU_CONTROL_KEYS : SHARED_DURING_CONTROL_KEYS;
  const playbackControlTitle = onlyMenus ? 'Comportement des dossiers' : "Pendant l'histoire";
  const batchGenerationDescription = canGenerateTextImages
    ? "Crée d'un coup une image-titre pour chaque histoire ou dossier avec image sélectionné, ou un audio (le nom prononcé) pour les éléments sélectionnés compatibles. Les packs ZIP importés sont ignorés."
    : "Crée d'un coup un audio (le nom prononcé) pour les éléments sélectionnés compatibles. Les images-titres ne sont proposées que pour les histoires et les dossiers avec image.";

  function getSelectedVoice() {
    if ((xttsSettings?.backend || 'piper') === 'piper') {
      // Piper a toujours une voix par défaut : jamais vide, pas de pré-sélection requise.
      return xttsSettings?.piperVoice || read(KEYS.PIPER_LAST_VOICE) || PIPER_DEFAULT_VOICE;
    }
    const favoriteVoices = Array.isArray(xttsSettings?.favoriteVoices) ? xttsSettings.favoriteVoices : [];
    return (
      read(KEYS.XTTS_LAST_VOICE) ||
      read(KEYS.XTTS_LAST_SPEAKER) ||
      favoriteVoices[0] ||
      ''
    );
  }

  function getNodeTitle(node) {
    return (node.name && node.name.trim()) ? node.name.trim() : 'Sans titre';
  }

  async function handleGenerateTextImagesFromNames() {
    if (batchBusy) return;
    setBatchError('');
    setBatchImageGenerating(true);
    const imageUpdates = new Map();
    const errors = [];

    try {
      for (const node of textImageNodes) {
        const text = getNodeTitle(node);
        const isMenu = node.type === 'menu';

        try {
          const imagePath = await generateTextImage(text);
          if (imagePath) {
            onMediaCreated?.(imagePath);
            imageUpdates.set(
              node.id,
              isMenu
                ? { image: imagePath, autoGenerateImage: false }
                : { itemImage: imagePath, autoGenerateImage: false },
            );
          }
        } catch {
          errors.push(`${text} : image-titre impossible à générer`);
        }
      }

      if (imageUpdates.size > 0) {
        onBulkUpdateItems(
          [...imageUpdates.keys()],
          (entry) => imageUpdates.get(entry.id) || {},
        );
      }

      if (errors.length > 0) {
        setBatchError(errors.join(' · '));
      }
    } finally {
      setBatchImageGenerating(false);
    }
  }

  async function handleGenerateTitleAudiosFromNames() {
    if (batchBusy) return;
    setBatchError('');

    const voice = getSelectedVoice();
    if (!voice) {
      const msg = 'Choisis une voix XTTS une première fois (depuis le bouton TTS d’un audio) avant de lancer la génération groupée.';
      setBatchError(msg);
      showErrorDialog({
        title: 'Génération audio',
        message: msg,
        variant: 'warning',
      });
      return;
    }

    setBatchAudioGenerating(true);
    const errors = [];

    try {
      for (const node of titleAudioNodes) {
        const text = getNodeTitle(node);
        const isMenu = node.type === 'menu';
        const target = (() => {
          if (node.type === 'root') return { kind: 'root', field: 'rootAudio' };
          if (node.type === 'end-node') return { kind: 'root', field: 'nightModeAudio' };
          if (isMenu) return { kind: 'menu', entryId: node.id, field: 'audio' };
          return { kind: 'story', entryId: node.id, field: 'itemAudio' };
        })();
        try {
          await onQueueXttsGenerate?.({
            target,
            targetLabel: `${text} — titre`,
            voiceLabel: voice,
            request: {
              text,
              language: xttsSettings?.language || 'fr',
              speaker: null,
              voice,
              savePath,
              filenameHint: `selection-${text}`,
            },
          });
        } catch {
          errors.push(`${text} : job XTTS non ajouté`);
        }
      }

      if (errors.length > 0) {
        setBatchError(errors.join(' · '));
      }
    } finally {
      setBatchAudioGenerating(false);
    }
  }

  if (nodes.length === 0) return null;

  return (
    <>
      {(canGenerateTextImages || titleAudioNodes.length > 0) && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Génération groupée</div>
          </div>
          <div className="editor-setting-row is-action-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">Générer à partir des noms</div>
              <div className="editor-setting-desc">
                {batchGenerationDescription}
              </div>
            </div>
            <div className="editor-setting-actions">
              {canGenerateTextImages ? (
                <button
                  type="button"
                  className="batch-generate-btn"
                  onClick={handleGenerateTextImagesFromNames}
                  disabled={batchBusy}
                >
                  <Sparkles className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  {batchImageGenerating ? 'Images…' : 'Images-titres'}
                </button>
              ) : null}
              {isTtsAvailable(xttsSettings) && titleAudioNodes.length > 0 && (
                <button
                  type="button"
                  className="batch-generate-btn"
                  onClick={handleGenerateTitleAudiosFromNames}
                  disabled={batchBusy}
                >
                  <Speech className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  {batchAudioGenerating ? 'Audios…' : 'Audios titres'}
                </button>
              )}
            </div>
          </div>
          {batchError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>
              {batchError}
            </div>
          )}
        </div>
      )}

      {editableNodes.length > 0 && (
        onlyStories ? (() => {
          const pauseState = getMixedBooleanValue(
            editableNodes.map((n) => n.controlSettings?.pause ?? STORY_DEFAULTS.pause),
          );
          const homeState = getMixedBooleanValue(
            editableNodes.map((n) => !n.returnOnHomeNone),
          );
          const showHomeDestination = homeState.isMixed || homeState.value;

          return (
            <div className="card during-play-card">
              <div className="card-title-row">
                <div className="card-title">Pendant l'histoire</div>
                <div className="card-copy card-copy--inline">
                  Choisis les boutons utilisables pendant la lecture de l'histoire.
                </div>
              </div>

              <div className="during-play-stack">
                <div className="sequence-controls during-play-toggles">
                  <label className="sequence-control">
                    <Toggle
                      on={pauseState.value}
                      mixed={pauseState.isMixed}
                      onChange={(v) => handleControlChange('pause', v)}
                      ariaLabel="Bouton Pause"
                    />
                    <Tooltip
                      text={pauseState.isMixed
                        ? 'Réglage différent selon les histoires sélectionnées.'
                        : pauseState.value
                          ? "L'enfant peut utiliser le bouton pause pendant l'histoire."
                          : "L'enfant ne peut pas utiliser le bouton pause pendant l'histoire."}
                      placement="above"
                      style={{ minWidth: 0 }}
                    >
                      <span className="during-play-control-title">Bouton Pause</span>
                    </Tooltip>
                  </label>
                </div>

                <div className="during-play-home">
                  <div className="sequence-control during-play-home-head">
                    <Toggle
                      on={homeState.value}
                      mixed={homeState.isMixed}
                      onChange={(v) => {
                        onBulkUpdateItems(editableIds, () => ({
                          returnOnHome: null,
                          returnOnHomeNone: !v,
                        }));
                      }}
                      ariaLabel="Bouton Accueil"
                    />
                    <Tooltip
                      text={homeState.isMixed
                        ? 'Réglage différent selon les histoires sélectionnées.'
                        : homeState.value
                          ? "L'enfant peut appuyer sur le bouton Accueil pendant l'histoire."
                          : "L'enfant ne peut pas appuyer sur le bouton Accueil pendant l'histoire."}
                      placement="above"
                      style={{ minWidth: 0 }}
                    >
                      <span className="during-play-control-title">Bouton Accueil</span>
                    </Tooltip>
                    {showHomeDestination ? (
                      <>
                        <span className="during-play-destination-label">Destination</span>
                        <div className="during-play-home-select">
                          <NavigationTargetSelect
                            value={getMixedSelectValue('returnOnHome')}
                            onChange={(target) => {
                              if (target === '__mixed__') return;
                              onBulkUpdateItems(editableIds, () => ({
                                returnOnHome: target || null,
                                returnOnHomeNone: false,
                              }));
                            }}
                            allMenus={allMenus}
                            allStories={allStories.filter((s) => !ids.includes(s.id))}
                            currentStoryId={null}
                            emptyLabel="Retour direct au menu parent"
                            includeStoryPlay={false}
                            size="compact"
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })() : (
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{playbackControlTitle}</div>
        </div>
        <div className="editor-setting-stack">
        {onlyMenus && (() => {
          const vals = editableNodes.map((n) => !!n.autoBlackImage);
          const unique = [...new Set(vals)];
          const isMixed = unique.length > 1;
          const value = isMixed ? false : unique[0];
          return (
            <div className="editor-setting-row is-toggle-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">Pas d'image</div>
                <div className="editor-setting-desc">
                  Ces dossiers n'envoient aucune image à la Lunii — l'écran conserve l'affichage précédent pendant la sélection.
                </div>
              </div>
              <div className="editor-setting-control">
                <Toggle
                  on={value}
                  mixed={isMixed}
                  onChange={(v) => handleAutoBlackImageChange(v)}
                />
              </div>
            </div>
          );
        })()}
        {playbackControlKeys.map(({ key, label, desc }) => {
          const vals = editableNodes.map((n) => n.controlSettings?.[key] ?? getDefaults(n.type)[key] ?? false);
          const unique = [...new Set(vals)];
          const isMixed = unique.length > 1;
          const value = isMixed ? false : unique[0];

          return (
            <div key={key} className="editor-setting-row is-toggle-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">{label}</div>
                <div className="editor-setting-desc">{desc}</div>
              </div>
              <div className="editor-setting-control">
                <Toggle
                  on={value}
                  mixed={isMixed}
                  onChange={(v) => handleControlChange(key, v)}
                />
              </div>
            </div>
          );
        })}
        {onlyStories && (
          <div className="editor-setting-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">Bouton Accueil</div>
              <div className="editor-setting-desc">
                Destination quand l'enfant appuie sur Accueil pendant la lecture.
                Sans réglage spécifique : retour au dossier parent.
              </div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={getMixedSelectValue('returnOnHome')}
                onChange={(target) => {
                  if (target === '__mixed__') return;
                  handleNavChange('returnOnHome', target);
                }}
                allMenus={allMenus}
                allStories={allStories.filter((s) => !ids.includes(s.id))}
                currentStoryId={null}
                emptyLabel="Retour direct au menu parent"
                includeStoryPlay={false}
              />
            </div>
          </div>
        )}
        </div>
      </div>
        )
      )}

      {allSameType && hasEndNode && (onlyStories || onlyMenus) && (
        onlyStories ? (
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">Après la lecture</div>
              <div className="card-copy card-copy--inline">
                Que se passe-t-il quand ces histoires se terminent.
              </div>
            </div>

            <div className="after-play-route">
              <div className="after-play-route-head">
                <div className="after-play-route-title">Résumé du parcours</div>
              </div>
              <div className="after-play-route-list">
                <span className="after-play-route-chip">
                  <span className="after-play-route-icon"><CircleStop strokeWidth={2} absoluteStrokeWidth /></span>
                  <span>Histoires terminées</span>
                </span>
                <span className="after-play-route-arrow" aria-hidden="true">→</span>
                <span className="after-play-route-chip">
                  <span className="after-play-route-icon"><Moon strokeWidth={2} absoluteStrokeWidth /></span>
                  <span>{project?.endNodeName || 'Message de fin'}{project?.globalOptions?.nightMode ? ' (mode nuit)' : ''}</span>
                </span>
                <span className="after-play-route-arrow" aria-hidden="true">→</span>
                <span className="after-play-route-chip is-destination">
                  <span>Destination du message de fin</span>
                </span>
              </div>
            </div>

            <div className="after-play-destination-row">
              <div className="after-play-destination-copy">
                <span className="field-label">Message de fin commun</span>
                <div className="after-play-muted">
                  La Lunii continue automatiquement après chaque audio d'histoire pour jouer ce message. Pour modifier la destination, sélectionne le message de fin dans l'arbre à gauche.
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">Après la lecture</div>
            </div>
            <div className="editor-setting-row is-note-row">
              <Moon className="editor-setting-icon" />
              <div className="editor-setting-copy">
                <div className="editor-setting-title">Destination gérée par le message de fin</div>
                <div className="editor-setting-desc">
                  La destination après chaque histoire est gérée par le message de fin du pack. Pour la modifier, sélectionne le message de fin dans l'arbre à gauche.
                </div>
              </div>
            </div>
          </div>
        )
      )}

      {allSameType && !hasEndNode && (allMenus.length > 0 || onlyStories) && (
        onlyStories ? (() => {
            const vals = editableNodes.map((n) => !!(n.controlSettings?.[STORY_AFTER_CONTROL.key] ?? STORY_DEFAULTS.autoplay) || !!n.returnAfterPlay);
            const unique = [...new Set(vals)];
            const isMixed = unique.length > 1;
            const value = isMixed ? false : unique[0];
            const showDestination = allMenus.length > 0 && (isMixed || value);

            return (
              <div className="card">
                <div className="card-title-row">
                  <div className="card-title">Après la lecture</div>
                  <div className="card-copy card-copy--inline">
                    Que se passe-t-il quand ces histoires se terminent.
                  </div>
                </div>

                <div className="after-play-main-row">
                  <div className="after-play-end-row">
                    <span className="after-play-end-label">À la fin</span>
                    <div className="story-end-mode" role="group" aria-label="Comportement à la fin des histoires">
                      <button
                        type="button"
                        className={`story-end-mode-btn ${!isMixed && !value ? 'is-active' : ''}`}
                        aria-pressed={!isMixed && !value}
                        onClick={() => handleStoryAutoContinuationChange(false)}
                      >
                        Rester sur l'écran
                      </button>
                      <button
                        type="button"
                        className={`story-end-mode-btn ${!isMixed && value ? 'is-active' : ''}`}
                        aria-pressed={!isMixed && value}
                        onClick={() => handleStoryAutoContinuationChange(true)}
                      >
                        Enchaîner
                      </button>
                    </div>
                  </div>
                </div>

                <div className="after-play-route">
                  <div className="after-play-route-head">
                    <div className="after-play-route-title">Résumé du parcours</div>
                    {isMixed ? <div className="after-play-route-context">Comportements différents</div> : null}
                  </div>
                  <div className="after-play-route-list">
                    <span className="after-play-route-chip">
                      <span className="after-play-route-icon"><CircleStop strokeWidth={2} absoluteStrokeWidth /></span>
                      <span>Histoires terminées</span>
                    </span>
                    <span className="after-play-route-arrow" aria-hidden="true">→</span>
                    {isMixed ? (
                      <span className="after-play-route-chip is-destination">
                        <span>Selon chaque histoire</span>
                      </span>
                    ) : value ? (
                      <span className="after-play-route-chip is-destination">
                        <span>Destination configurée</span>
                      </span>
                    ) : (
                      <span className="after-play-route-chip">
                        <span className="after-play-route-icon"><Pause strokeWidth={2} absoluteStrokeWidth /></span>
                        <span>Attente sur l'écran</span>
                      </span>
                    )}
                  </div>
                </div>

                {showDestination && (
                  <div className="after-play-destination-row">
                    <div className="after-play-destination-copy">
                      <span className="field-label">Destination après l'histoire</span>
                      <div className="after-play-muted">
                        L'écran ou le menu affiché à la sortie automatique.
                      </div>
                    </div>
                    <div className="after-play-destination-select">
                      <NavigationTargetSelect
                        value={getMixedSelectValue('returnAfterPlay')}
                        onChange={(target) => {
                          if (target === '__mixed__') return;
                          handleNavChange('returnAfterPlay', target);
                        }}
                        allMenus={allMenus}
                        allStories={allStories.filter((s) => !ids.includes(s.id))}
                        currentStoryId={null}
                        emptyLabel="Suit la destination du dossier parent"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })() : (
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">Après la lecture</div>
            </div>
            <div className="editor-setting-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">Destination de fin d'histoire</div>
                <div className="editor-setting-desc">
                  Destination à la fin de l'histoire — suit le dossier parent si rien n’est choisi ici.
                </div>
              </div>
              <div className="editor-setting-control">
                <NavigationTargetSelect
                  value={getMixedSelectValue('returnAfterPlay')}
                  onChange={(target) => {
                    if (target === '__mixed__') return;
                    handleNavChange('returnAfterPlay', target);
                  }}
                  allMenus={allMenus}
                  allStories={allStories.filter((s) => !ids.includes(s.id))}
                  currentStoryId={null}
                  emptyLabel="Suit la destination du dossier parent"
                />
              </div>
            </div>
          </div>
        )
      )}

      {!allSameType && (
        <div className="multiselect-mixed-note">
          Sélection mixte (histoires et dossiers) — seuls les contrôles de lecture peuvent être modifiés en groupe ici. Pour le reste, sélectionne un seul type d'élément à la fois.
        </div>
      )}

      {colorableIds.length > 0 && (() => {
        const currentColor = getMixedColor();
        return (
          <div className="card">
            <div className="editor-setting-row is-action-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">Couleur</div>
                <div className="editor-setting-desc">
                  {currentColor === '__mixed__'
                    ? `Couleurs différentes sur ${colorableIds.length} éléments — choisir pour uniformiser.`
                    : `Pastille affichée à gauche du nom dans l'arbre (${colorableIds.length} éléments).`}
                </div>
              </div>
              <div className="multiselect-color-dots">
                {TREE_COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`ctx-color-dot${currentColor === color ? ' is-active' : ''}`}
                    style={{ backgroundColor: color }}
                    title={color}
                    onClick={() => handleSetColor(color)}
                  />
                ))}
                <button
                  type="button"
                  className={`ctx-color-clear${currentColor === null ? ' is-active' : ''}`}
                  title={currentColor === '__mixed__' ? 'Couleurs différentes — cliquer pour effacer' : 'Aucune couleur'}
                  onClick={() => handleSetColor(null)}
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={() => onBulkDeleteItems?.(ids)}
            aria-label="Supprimer la sélection"
            title="Supprimer la sélection"
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">Supprimer la sélection</span>
          <p className="card-danger-desc">
            Supprime {nodes.length} élément{nodes.length > 1 ? 's' : ''} du projet : {bannerParts.join(', ')}.
          </p>
        </div>
      </div>
    </>
  );
});
