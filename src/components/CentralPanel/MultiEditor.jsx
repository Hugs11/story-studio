import { memo, useMemo, useState } from 'react';
import { Toggle } from '../common/Toggle';
import { findEntryById } from '../../store/projectModel';
import { useProjectContext } from '../../store/ProjectContext';
import { KEYS, read } from '../../store/persistentSettings';
import { useErrorDialog } from '../common/Dialog';
import { generateTextImage } from '../TextImageGenerator/generateTextImage';
import { Moon } from '../icons/LucideLocal';
import { NavigationTargetSelect } from './story/storyUtils';
import {
  canShowTextImageBatchAction,
  getTextImageBatchTargets,
} from './multiEditorBatchTargets';

const STORY_DEFAULTS = { autoplay: false, pause: true, wheel: false };
const MENU_DEFAULTS = { autoplay: false, pause: false, wheel: true };
const TREE_COLOR_PALETTE = ['#e24b4a', '#ef9f27', '#f0c84b', '#5fbf6b', '#3d9be9', '#7c6af7', '#d95bb4'];

const SHARED_DURING_CONTROL_KEYS = [
  { key: 'pause',    label: 'Bouton pause',         desc: 'Autorise la pause pendant la lecture' },
  { key: 'wheel',    label: 'Molette de sélection', desc: 'Autorise la molette pendant la lecture' },
];

const MENU_CONTROL_KEYS = [
  { key: 'wheel',    label: 'Molette de sélection', desc: 'Autorise la molette pour choisir une histoire' },
  { key: 'autoplay', label: 'Lecture automatique',  desc: "L'audio de présentation enchaîne directement sur la première histoire, sans attendre OK" },
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
      controlSettings: { ...entry.controlSettings, autoplay: value },
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

  const batchBusy = batchImageGenerating || batchAudioGenerating;
  const playbackControlKeys = onlyMenus ? MENU_CONTROL_KEYS : SHARED_DURING_CONTROL_KEYS;
  const playbackControlTitle = onlyMenus ? 'Comportement des dossiers' : 'Pendant la lecture';
  const batchGenerationDescription = canGenerateTextImages
    ? "Crée d'un coup une image texte pour chaque histoire ou dossier avec image sélectionné, ou un audio (le nom prononcé) pour les éléments sélectionnés compatibles. Les packs ZIP importés sont ignorés."
    : "Crée d'un coup un audio (le nom prononcé) pour les éléments sélectionnés compatibles. Les images texte ne sont proposées que pour les histoires et les dossiers avec image.";

  function getSelectedVoice() {
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
          errors.push(`${text} : image texte impossible à générer`);
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
      <div
        className="card"
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1 }}>⊞</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{nodes.length} éléments sélectionnés</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{bannerParts.join(', ')}</div>
        </div>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => onBulkDeleteItems?.(ids)}
        >
          Supprimer
        </button>
      </div>

      {(canGenerateTextImages || titleAudioNodes.length > 0) && (
        <div className="card">
          <div className="card-title">Génération groupée</div>
          <div className="field-row">
            <div style={{ flex: 1 }}>
              <span className="field-label">Générer à partir des noms</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {batchGenerationDescription}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {canGenerateTextImages ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleGenerateTextImagesFromNames}
                  disabled={batchBusy}
                >
                  {batchImageGenerating ? 'Images…' : 'Images texte'}
                </button>
              ) : null}
              {xttsSettings?.enabled && titleAudioNodes.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleGenerateTitleAudiosFromNames}
                  disabled={batchBusy}
                >
                  {batchAudioGenerating ? 'Audios…' : 'Audios titres'}
                </button>
              )}
            </div>
          </div>
          {batchError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-danger, #ff7676)' }}>
              {batchError}
            </div>
          )}
        </div>
      )}

      {editableNodes.length > 0 && (
      <div className="card">
        <div className="card-title">{playbackControlTitle}</div>
        {onlyMenus && (() => {
          const vals = editableNodes.map((n) => !!n.autoBlackImage);
          const unique = [...new Set(vals)];
          const isMixed = unique.length > 1;
          const value = isMixed ? false : unique[0];
          return (
            <div className="field-row" style={{ marginBottom: 4 }}>
              <div style={{ flex: 1 }}>
                <span className="field-label">Pas d'image</span>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  Ces dossiers n'envoient aucune image à la Lunii — l'écran conserve l'affichage précédent pendant la sélection.
                </div>
              </div>
              <Toggle
                on={value}
                mixed={isMixed}
                onChange={(v) => handleAutoBlackImageChange(v)}
              />
            </div>
          );
        })()}
        {playbackControlKeys.map(({ key, label, desc }) => {
          const vals = editableNodes.map((n) => n.controlSettings?.[key] ?? getDefaults(n.type)[key] ?? false);
          const unique = [...new Set(vals)];
          const isMixed = unique.length > 1;
          const value = isMixed ? false : unique[0];

          return (
            <div key={key} className="field-row" style={{ marginBottom: 4 }}>
              <div style={{ flex: 1 }}>
                <span className="field-label">{label}</span>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{desc}</div>
              </div>
              <Toggle
                on={value}
                mixed={isMixed}
                onChange={(v) => handleControlChange(key, v)}
              />
            </div>
          );
        })}
        {onlyStories && (
          <div className="field-row" style={{ marginTop: 4 }}>
            <div style={{ flex: 1 }}>
              <span className="field-label">Accueil</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                Destination quand l'enfant appuie sur Accueil pendant la lecture.
                Sans réglage spécifique : retour direct au menu parent{hasEndNode ? ' (sans passer par le message de fin)' : ''}.
              </div>
            </div>
            <div style={{ maxWidth: 220, width: '100%' }}>
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
              includeRoot={false}
              includeStoryPlay={false}
            />
            </div>
          </div>
        )}
      </div>
      )}

      {allSameType && hasEndNode && (onlyStories || onlyMenus) && (
        <div className="card">
          <div className="card-title">Après la lecture</div>
          {onlyStories && (
            <div className="field-row" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <span className="field-label">Fin de l'histoire</span>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  Passage automatique par le message de fin du pack
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  La Lunii continue automatiquement après chaque audio d'histoire pour jouer ce message de fin.
                </div>
              </div>
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 4px',
            }}
          >
            <Moon style={{ width: 18, height: 18, flexShrink: 0 }} />
            <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              {onlyMenus
                ? 'La destination après chaque histoire est gérée par le message de fin du pack.'
                : 'La destination après lecture est gérée par le message de fin du pack.'}
              <br />
              Pour la modifier, sélectionne le message de fin dans l'arbre à gauche.
            </div>
          </div>
        </div>
      )}

      {allSameType && !hasEndNode && (allMenus.length > 0 || onlyStories) && (
        <div className="card">
          <div className="card-title">
            {onlyMenus ? 'Après la lecture (défaut enfants)' : 'Après la lecture'}
          </div>

          {onlyStories && (() => {
            const vals = editableNodes.map((n) => !!(n.controlSettings?.[STORY_AFTER_CONTROL.key] ?? STORY_DEFAULTS.autoplay) || !!n.returnAfterPlay);
            const unique = [...new Set(vals)];
            const isMixed = unique.length > 1;
            const value = isMixed ? false : unique[0];

            return (
              <div className="field-row">
                <div style={{ flex: 1 }}>
                  <span className="field-label">Fin de l'histoire</span>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    {isMixed
                      ? 'Comportements différents selon les histoires'
                      : value
                        ? 'La Lunii enchaîne vers la destination'
                        : "La Lunii reste sur l'écran de lecture"}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                    {isMixed
                      ? 'Certaines histoires enchaînent automatiquement, les autres restent sur leur écran de lecture.'
                      : value
                        ? STORY_AFTER_CONTROL.desc
                        : "Aucune destination de fin n'est lancée automatiquement. Le bouton Accueil, s'il est actif, reste le chemin de sortie."}
                  </div>
                </div>
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
            );
          })()}

          {allMenus.length > 0 && (!onlyStories || (() => {
            const vals = editableNodes.map((n) => !!(n.controlSettings?.[STORY_AFTER_CONTROL.key] ?? STORY_DEFAULTS.autoplay) || !!n.returnAfterPlay);
            const unique = [...new Set(vals)];
            return unique.length > 1 || unique[0] === true;
          })()) && (
            <div className="field-row">
              <div style={{ flex: 1 }}>
                <span className="field-label">{onlyStories ? 'Puis destination' : "À la fin de l'histoire, retour vers"}</span>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {onlyStories
                    ? 'Où l’enfant atterrit après la sortie automatique.'
                    : 'Destination après la lecture — suit le dossier parent si rien n’est choisi ici.'}
                </div>
              </div>
              <div style={{ maxWidth: 220, width: '100%' }}>
              <NavigationTargetSelect
                value={getMixedSelectValue('returnAfterPlay')}
                onChange={(target) => {
                  if (target === '__mixed__') return;
                  handleNavChange('returnAfterPlay', target);
                }}
                allMenus={allMenus}
                allStories={onlyStories ? allStories.filter((s) => !ids.includes(s.id)) : []}
                currentStoryId={null}
                emptyLabel="Suit la destination du dossier parent"
                includeRoot={false}
                includeStoryPlay={false}
              />
              </div>
            </div>
          )}

        </div>
      )}

      {!allSameType && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--color-text-tertiary)',
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 10,
          }}
        >
          Sélection mixte (histoires et dossiers) — seuls les contrôles de lecture peuvent être modifiés en groupe ici. Pour le reste, sélectionne un seul type d'élément à la fois.
        </div>
      )}

      {colorableIds.length > 0 && (() => {
        const currentColor = getMixedColor();
        return (
          <div className="card">
            <div className="field-row" style={{ alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <span className="field-label">Couleur</span>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {currentColor === '__mixed__'
                    ? `Couleurs différentes sur ${colorableIds.length} éléments — choisir pour uniformiser.`
                    : `Pastille affichée à gauche du nom dans l'arbre (${colorableIds.length} éléments).`}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
    </>
  );
});
