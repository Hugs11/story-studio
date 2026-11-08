import { useTranslation } from 'react-i18next';
import { audioLevelMessage } from '../../store/audioLevelNotice.js';
import { Tooltip } from '../common/Tooltip';

// Repère ambre posé à côté du nom du son : le verdict de niveau connu avant la
// génération. Le texte annonce l'effet de la future harmonisation ; sans
// harmonisation du volume, « presque muet » prend un texte adapté.
export function AudioLevelMark({ mark, label }) {
  const { t } = useTranslation('tree');
  if (!mark) return null;
  const message = audioLevelMessage(mark, label, t);
  const current = t('tree:audio.level.current');
  const bubble = <><span className="audio-level-line">{message}</span><span className="audio-level-line">{current}</span></>;
  return (
    <Tooltip text={bubble} wrap asChild>
      <span
        className="audio-level-mark"
        role="img"
        tabIndex={0}
        aria-label={`${message} ${current}`}
        data-level-notice={mark.code}
      />
    </Tooltip>
  );
}
