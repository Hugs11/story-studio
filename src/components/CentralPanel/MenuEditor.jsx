import { memo, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { Toggle } from '../common/Toggle';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { Trash2 } from '../icons/LucideLocal';
import { NavigationTargetSelect } from './story/storyUtils';
import { getGeneratedMenuControls } from '../../store/generatedPlayback';
import './CentralPanel.css';

const MENU_BEHAVIOR_CONTROLS = [
  {
    key: 'wheel',
    label: 'Molette de sélection',
    desc: "L'enfant peut parcourir les histoires de ce dossier avec la molette.",
    def: true,
  },
  {
    key: 'autoplay',
    label: 'Lecture automatique',
    desc: "Après l'audio de sélection, enchaîne automatiquement vers le contenu du dossier, sans appui sur OK.",
    def: false,
  },
  {
    key: 'pause',
    label: 'Bouton Pause',
    desc: "L'enfant peut mettre en pause l'audio de sélection du dossier.",
    def: false,
  },
];

export const MenuEditor = memo(function MenuEditor({ node, project = null, parentMenu = null, allMenus = [], allStories = [], onUpdate, onDelete }) {
  const isImportedContinuation = !!node.importedContinuation;
  const isAutoplaySelector = node.controlSettings?.autoplay === true && node.controlSettings?.wheel === false;
  const generatedMenuControls = getGeneratedMenuControls(node, parentMenu, project);
  const forcedAutoplay = generatedMenuControls.forceAutoplay && node.controlSettings?.autoplay !== true;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;
  const destinationHelp = node.returnAfterPlay
    ? "Les histoires de ce dossier sans destination propre iront vers la destination choisie ci-dessous, au lieu de revenir à ce dossier."
    : "À la fin d'une histoire sans destination propre, l'enfant revient à ce dossier (son audio de sélection, puis la molette pour rechoisir une histoire). Choisis un autre dossier seulement pour le rediriger ailleurs.";

  const [textImgModal, setTextImgModal] = useState(null);

  function handleRegenerate() {
    setTextImgModal({
      defaultText: node.name || '',
      onConfirm: (path) => { onUpdate({ image: path, autoGenerateImage: false }); },
    });
  }

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Dossier</div>
          <div className="card-copy card-copy--inline">Page de choix où l'enfant sélectionne une histoire à la molette. Configure ici son nom, son visuel et l'audio d'invitation.</div>
        </div>

        <div className="field-row field-row--flush">
          <span className="field-label">Nom</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Nom du dossier"
          />
          <span className="menu-count">
            {node.children?.length ?? node.items?.length ?? 0} élément(s)
          </span>
        </div>
        <div className="card-sep" />

        {node.importedContinuation && (
          <div className="sequence-note sequence-note--spaced">
            Continuation native importée depuis {node.importedContinuation.sourceStoryName || 'une histoire'}
            {node.importedContinuation.sourceStepName ? ` · étape ${node.importedContinuation.sourceStepName}` : ''}.
          </div>
        )}
        {isAutoplaySelector ? (
          <div className="sequence-note sequence-note--spaced">
            Sélecteur autoplay transparent : ce dossier joue son audio puis enchaîne vers ses choix sans navigation à la molette.
          </div>
        ) : null}
        {forcedAutoplay ? (
          <div className="sequence-note sequence-note--spaced">
            Ce dossier sera traversé automatiquement à l'export : il sert d'étape technique vers son contenu, pas d'écran de choix.
          </div>
        ) : null}
        {nativeGraph ? (
          <div className="sequence-note sequence-note--spaced">
            Graphe interactif natif attaché à ce pack extrait : {nativeGraphStageCount} stages, {nativeGraphActionCount} actions.
          </div>
        ) : null}
        {node.autoBlackImage ? (
          <>
            <AudioField
              accentLabel
              label="Audio de sélection"
              description={isImportedContinuation ? 'Optionnel pour cette continuation' : "Invite l'enfant à choisir une histoire"}
              file={node.audio}
              required={!isImportedContinuation}
              ttsTextSuggestion={node.name || ''}
              ttsFilenameHint={`selection-${node.name || 'dossier'}`}
              xttsTarget={{ kind: 'menu', entryId: node.id, field: 'audio' }}
              onPick={(f) => onUpdate({ audio: f })}
              onClear={() => onUpdate({ audio: null })}
            />
          </>
        ) : (
          <div className="media-split">
            <div className="media-split-left">
              <div className="media-col-header">
                Image
                <span className="media-col-subtitle">Image de menu (320×240)</span>
              </div>
              <ImageField
                accentLabel
                fieldId={`${node.id}:image`}
                file={node.image}
                extraActions={[
                  {
                    key: 'generate-text',
                    label: 'Générer un texte',
                    icon: '✦',
                    onClick: handleRegenerate,
                    title: 'Créer une image texte à partir du nom du dossier',
                  },
                ]}
                onPick={(f) => onUpdate({ image: f, autoGenerateImage: false })}
                onClear={() => onUpdate({ image: null, autoGenerateImage: false })}
              />
            </div>
            <div className="media-split-divider" />
            <div className="media-split-right">
              <div className="media-col-header">
                Son
                <span className="media-col-subtitle">
                  {isImportedContinuation ? 'Audio de sélection — optionnel pour cette continuation' : "Audio de sélection — invite l'enfant à choisir une histoire"}
                </span>
              </div>
              <AudioField
                accentLabel
                label="Audio de sélection"
                description={isImportedContinuation ? 'Optionnel pour cette continuation' : "Invite l'enfant à choisir une histoire"}
                file={node.audio}
                required={!isImportedContinuation}
                ttsTextSuggestion={node.name || ''}
                ttsFilenameHint={`selection-${node.name || 'dossier'}`}
                xttsTarget={{ kind: 'menu', entryId: node.id, field: 'audio' }}
                onPick={(f) => onUpdate({ audio: f })}
                onClear={() => onUpdate({ audio: null })}
              />
            </div>
          </div>
        )}
      </div>

      {nativeGraph ? (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Graphe interactif importé</div>
            <div className="card-copy card-copy--inline">{nativeGraphStageCount} stages · {nativeGraphActionCount} actions</div>
          </div>
          <NativeGraphEditor
            graph={nativeGraph}
            onChange={(nextGraph) => onUpdate({ nativeGraph: nextGraph })}
          />
        </div>
      ) : null}

      <div className="card menu-behavior-card">
        <div className="card-title-row">
          <div className="card-title">Réglages du dossier</div>
          <div className="card-copy card-copy--inline">
            Règle ce que l'enfant peut faire sur cet écran de choix.
          </div>
        </div>

        <div className="menu-behavior-stack">
          <label className="sequence-control menu-behavior-control">
          <Toggle
            on={node.autoBlackImage || false}
            onChange={(v) => onUpdate({ autoBlackImage: v })}
            ariaLabel="Écran sans image"
          />
            <div className="menu-behavior-copy">
              <span className="during-play-control-title">Écran transparent</span>
              <span className="menu-behavior-desc">
                Aucune image n'est affichée, l'écran reste vide.
              </span>
            </div>
          </label>
          {MENU_BEHAVIOR_CONTROLS.map(({ key, label, desc, def }) => (
            <label key={key} className="sequence-control menu-behavior-control">
              <Toggle
                on={node.controlSettings?.[key] ?? def}
                onChange={(v) => onUpdate({ controlSettings: { ...node.controlSettings, [key]: v } })}
                ariaLabel={label}
              />
              <div className="menu-behavior-copy">
                <span className="during-play-control-title">{label}</span>
                <span className="menu-behavior-desc">{desc}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {allMenus.length > 1 && node.children?.some(c => c.type !== 'menu') && (
        <div className="card">
          <div className="card-title">Après chaque histoire de ce dossier</div>
          <div className="field-row">
            <span className="field-label" style={{ flex: 1 }}>Destination des histoires</span>
            <NavigationTargetSelect
              value={node.returnAfterPlay ?? ''}
              onChange={(target) => onUpdate({ returnAfterPlay: target || null })}
              allMenus={allMenus.filter((m) => m.id !== node.id)}
              allStories={allStories}
              currentStoryId={null}
              emptyLabel={node.name ? `Revient à « ${node.name} »` : 'Revient à ce dossier'}
              style={{ minWidth: 240, maxWidth: 360 }}
            />
          </div>
          <div className="menu-destination-help">
            {destinationHelp}
          </div>
        </div>
      )}

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={onDelete}
            aria-label="Supprimer ce dossier"
            title="Supprimer ce dossier"
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">Supprimer ce dossier</span>
          <p className="card-danger-desc">
            {(() => {
              const count = node.children?.length ?? node.items?.length ?? 0;
              return count > 0
                ? `Les ${count} élément${count > 1 ? 's' : ''} qu'il contient ${count > 1 ? 'seront déplacés' : 'sera déplacé'} à la racine.`
                : 'Le dossier sera retiré du projet.';
            })()}
          </p>
        </div>
      </div>

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
