import { memo, useMemo, useState } from 'react';
import { Toggle } from '../common/Toggle';
import { findEntryById } from '../../store/projectModel';
import { useProjectContext } from '../../store/ProjectContext';
import { generateTextImage } from '../TextImageGenerator/generateTextImage';
import { Moon } from '../icons/LucideLocal';
import { NavigationTargetSelect } from './story/storyUtils';

const STORY_DEFAULTS = { autoplay: false, pause: true, wheel: false };
const MENU_DEFAULTS = { autoplay: false, pause: false, wheel: true };

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
    () => ids.map((id) => findEntryById(project, id, projectIndex)).filter(Boolean),
    [ids, project, projectIndex],
  );

  const { xttsSettings, onQueueXttsGenerate, onMediaCreated, savePath } = useProjectContext();
  const [batchImageGenerating, setBatchImageGenerating] = useState(false);
  const [batchAudioGenerating, setBatchAudioGenerating] = useState(false);
  const [batchError, setBatchError] = useState('');

  const editableNodes = nodes.filter((n) => n.type === 'story' || n.type === 'menu');
  const editableIds = editableNodes.map((n) => n.id);
  const storyCount = nodes.filter((n) => n.type === 'story').length;
  const zipCount = nodes.filter((n) => n.type === 'zip').length;
  const menuCount = nodes.filter((n) => n.type === 'menu').length;
  const onlyStories = storyCount === nodes.length && storyCount > 0;
  const onlyMenus = menuCount === nodes.length && menuCount > 0;
  const allSameType = onlyStories || onlyMenus;
  const hasEndNode = !!project?.nightModeAudio || !!project?.globalOptions?.nightMode || !!project?.globalOptions?.endNode;

  const bannerParts = [];
  if (storyCount > 0) bannerParts.push(`${storyCount} histoire${storyCount > 1 ? 's' : ''}`);
  if (zipCount > 0) bannerParts.push(`${zipCount} ZIP`);
  if (menuCount > 0) bannerParts.push(`${menuCount} dossier${menuCount > 1 ? 's' : ''}`);

  function handleControlChange(key, value) {
    onBulkUpdateItems(editableIds, (entry) => ({
      controlSettings: { ...entry.controlSettings, [key]: value },
    }));
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

  function getSelectedVoice() {
    const favoriteVoices = Array.isArray(xttsSettings?.favoriteVoices) ? xttsSettings.favoriteVoices : [];
    return (
      localStorage.getItem('xtts_last_voice') ||
      localStorage.getItem('xtts_last_speaker') ||
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
      for (const node of editableNodes) {
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
      window.alert(msg);
      return;
    }

    setBatchAudioGenerating(true);
    const errors = [];

    try {
      for (const node of editableNodes) {
        const text = getNodeTitle(node);
        const isMenu = node.type === 'menu';
        try {
          await onQueueXttsGenerate?.({
            target: isMenu
              ? { kind: 'menu', entryId: node.id, field: 'audio' }
              : { kind: 'story', entryId: node.id, field: 'itemAudio' },
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

      {editableNodes.length > 0 && (
        <div className="card">
          <div className="card-title">Génération groupée</div>
          <div className="field-row">
            <div style={{ flex: 1 }}>
              <span className="field-label">Générer à partir des noms</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                Crée d'un coup une image texte (le nom écrit en gros) ou un audio (le nom prononcé) pour chaque élément sélectionné. Les packs ZIP importés sont ignorés.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleGenerateTextImagesFromNames}
                disabled={batchBusy}
              >
                {batchImageGenerating ? 'Images…' : 'Images texte'}
              </button>
              {xttsSettings?.enabled && (
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
                Par défaut : retour direct au menu parent{hasEndNode ? ' (sans passer par le nœud de fin)' : ''}.
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
              emptyLabel="Comportement par défaut"
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
                  Passage automatique par le nœud de fin du pack
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  La Lunii continue automatiquement après chaque audio d'histoire pour jouer ce nœud de fin.
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
                ? 'La destination après chaque histoire est gérée par le nœud de fin du pack.'
                : 'La destination après lecture est gérée par le nœud de fin du pack.'}
              <br />
              Pour la modifier, sélectionne le nœud de fin dans l'arbre à gauche.
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
                    : 'Destination après la lecture — peut hériter du réglage du dossier parent.'}
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
                emptyLabel="Réglage par défaut (hérité)"
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
    </>
  );
});
