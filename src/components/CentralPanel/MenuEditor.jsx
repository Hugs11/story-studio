import { memo, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { Toggle } from '../common/Toggle';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { TriangleAlert } from '../icons/LucideLocal';
import { NavigationTargetSelect } from './story/storyUtils';
import { getGeneratedMenuControls } from '../../store/generatedPlayback';
import './CentralPanel.css';

export const MenuEditor = memo(function MenuEditor({ node, project = null, parentMenu = null, allMenus = [], onUpdate, onDelete }) {
  const isImportedContinuation = !!node.importedContinuation;
  const isAutoplaySelector = node.controlSettings?.autoplay === true && node.controlSettings?.wheel === false;
  const generatedMenuControls = getGeneratedMenuControls(node, parentMenu, project);
  const forcedAutoplay = generatedMenuControls.forceAutoplay && node.controlSettings?.autoplay !== true;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;
  const destinationHelp = node.returnAfterPlay
    ? "Toutes les histoires de ce dossier qui n'ont pas leur propre destination configurée reviendront vers le dossier choisi ci-dessous."
    : "À la fin de chaque histoire, l'enfant revient sur ce dossier. Choisis un autre dossier seulement si tu veux le rediriger ailleurs.";

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

        <div className="field-row" style={{ marginBottom: 0 }}>
          <span className="field-label">Nom</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Nom du dossier"
          />
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
            {node.children?.length ?? node.items?.length ?? 0} élément(s)
          </span>
        </div>
        <div className="card-sep" />

        {node.importedContinuation && (
          <div className="sequence-note" style={{ marginBottom: 10 }}>
            Continuation native importée depuis {node.importedContinuation.sourceStoryName || 'une histoire'}
            {node.importedContinuation.sourceStepName ? ` · étape ${node.importedContinuation.sourceStepName}` : ''}.
          </div>
        )}
        {isAutoplaySelector ? (
          <div className="sequence-note" style={{ marginBottom: 10 }}>
            Sélecteur autoplay transparent : ce dossier joue son audio puis enchaîne vers ses choix sans navigation à la molette.
          </div>
        ) : null}
        {forcedAutoplay ? (
          <div className="sequence-note" style={{ marginBottom: 10 }}>
            Ce dossier sera traversé automatiquement à l'export : il sert d'étape technique vers son contenu, pas d'écran de choix.
          </div>
        ) : null}
        {nativeGraph ? (
          <div className="sequence-note" style={{ marginBottom: 10 }}>
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

      <div className="card">
        <div className="card-title">Comportement</div>
        <div className="field-row" style={{ marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <span className="field-label">Pas d'image</span>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              Ce dossier n'envoie aucune image à la Lunii — l'écran conserve l'affichage précédent pendant la sélection.
            </div>
          </div>
          <Toggle
            on={node.autoBlackImage || false}
            onChange={(v) => onUpdate({ autoBlackImage: v })}
          />
        </div>
        {[
          { key: 'wheel',    label: 'Molette de sélection', desc: 'L\'enfant peut tourner la molette pour choisir une histoire', def: true },
          { key: 'autoplay', label: 'Lecture automatique',  desc: "L'audio de présentation enchaîne directement sur la première histoire, sans attendre que l'enfant appuie sur OK", def: false },
          { key: 'pause',    label: 'Bouton pause',         desc: 'L\'enfant peut mettre en pause l\'audio de présentation', def: false },
        ].map(({ key, label, desc, def }) => (
          <div key={key} className="field-row" style={{ marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              <span className="field-label">{label}</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{desc}</div>
            </div>
            <Toggle
              on={node.controlSettings?.[key] ?? def}
              onChange={(v) => onUpdate({ controlSettings: { ...node.controlSettings, [key]: v } })}
            />
          </div>
        ))}
      </div>

      {allMenus.length > 1 && node.children?.some(c => c.type !== 'menu') && (
        <div className="card">
          <div className="card-title">Après chaque histoire de ce dossier</div>
          <div className="field-row">
            <div style={{ flex: 1 }}>
              <span className="field-label">Destination des histoires</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                Où l'enfant retourne quand une histoire de ce dossier se termine, si l'histoire n'a pas sa propre destination configurée.
              </div>
            </div>
            <NavigationTargetSelect
              value={node.returnAfterPlay ?? ''}
              onChange={(target) => onUpdate({ returnAfterPlay: target || null })}
              allMenus={allMenus.filter((m) => m.id !== node.id)}
              allStories={[]}
              currentStoryId={null}
              emptyLabel="Reste dans ce dossier"
              includeRoot={false}
              includeNextStory={false}
              includeStoryPlay={false}
              style={{ maxWidth: 180 }}
            />
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              padding: '8px 10px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {destinationHelp}
          </div>
        </div>
      )}

      <div className="card card--danger">
        <div className="card-danger-header">
          <TriangleAlert className="card-danger-icon" />
          <span>Zone sensible</span>
        </div>
        <div className="card-danger-divider" />
        <div className="card-danger-row">
          <div className="card-danger-text">
            <div className="card-danger-title">Supprimer ce dossier</div>
            <div className="card-danger-desc">
              {(() => {
                const count = node.children?.length ?? node.items?.length ?? 0;
                return count > 0
                  ? `Les ${count} élément${count > 1 ? 's' : ''} qu'il contient ${count > 1 ? 'seront déplacés' : 'sera déplacé'} à la racine.`
                  : 'Le dossier sera retiré du projet.';
              })()}
            </div>
          </div>
          <button className="btn btn-danger-outline" onClick={onDelete}>
            Supprimer
          </button>
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
