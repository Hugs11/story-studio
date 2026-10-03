// Adaptateur entre les champs média du Libre et les gestes du graphe.
// L'apparence, le choix de fichier, le glisser-déposer, l'édition, la lecture,
// l'enregistrement et la génération restent ceux des composants communs. La
// seule particularité est l'écriture : un Écran avancé se modifie par geste.
//
// **Remplacer est toujours local**, et il n'existe plus de geste global.
// `planStageMediaAssignment` partage une référence déjà liée *sans son chemin*,
// donc reposer un fichier sur cet Écran ne touche jamais les autres Écrans qui
// citent la même référence. Changer le fichier partout se fait sur le disque,
// sous le chemin que la liaison désigne.

import { useState } from 'react';

import { AudioField } from '../editors/AudioField.jsx';
import { ImageField } from '../editors/ImageField.jsx';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal.jsx';
import { advancedGestures, presence } from '../../store/projectModel/advancedGestures.js';

export function MediaSlotEditor({
  stage, field, usage, disabled, onGesture, onAssignMedia = null, projectEpoch = null,
}) {
  const slot = field === 'audio' ? stage.audio : stage.image;
  const assetRef = slot?.assetRef ?? null;
  const entry = assetRef ? usage?.get(assetRef) ?? null : null;
  const file = entry?.path ?? null;
  const [textImageOpen, setTextImageOpen] = useState(false);
  const stageName = stage.name?.presence === 'value' ? stage.name.value : '';

  const assign = async (path) => {
    if (!path || disabled || !onAssignMedia) return;
    await onAssignMedia(stage.uuid, field, path);
  };

  const clear = () => {
    if (disabled) return;
    void onGesture(advancedGestures.setStageMedia(stage.uuid, field, presence.null()));
  };

  return (
    <div className={`advanced-media-field advanced-media-field--${field}`}>
      {field === 'image' ? (
        <ImageField
          fieldId={`advanced:${stage.uuid}:image`}
          label={null}
          file={file}
          extraActions={[{
            key: 'generate-text',
            label: 'Générer une image-titre',
            onClick: () => setTextImageOpen(true),
            title: 'Créer une image-titre à partir du nom de l’Écran',
          }]}
          onPick={assign}
          onClear={clear}
        />
      ) : (
        <AudioField
          label="Audio de l’Écran"
          description="Joué lorsque cet Écran s’affiche"
          file={file}
          required={false}
          ttsTextSuggestion={stageName}
          ttsFilenameHint={`ecran-${stage.uuid}`}
          xttsTarget={{ kind: 'advancedStage', projectEpoch, apply: assign }}
          onPick={assign}
          onClear={clear}
        />
      )}

      {textImageOpen && (
        <TextImagePromptModal
          defaultText={stageName}
          onConfirm={(path) => {
            setTextImageOpen(false);
            void assign(path);
          }}
          onCancel={() => setTextImageOpen(false)}
        />
      )}
    </div>
  );
}
