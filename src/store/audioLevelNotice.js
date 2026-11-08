// Verdict de niveau d'un son posé dans un emplacement, avant toute génération.
// Le verdict brut vient de la mesure (`measureAudioLevel`) ; l'affichage le
// filtre selon l'option « Harmoniser le volume » du pack, sans remesurer.

export const NOTICE_STRONG_LIMITING = 'AUDIO_STRONG_LIMITING';
export const NOTICE_NEAR_MUTE_BOOST = 'AUDIO_NEAR_MUTE_BOOST';
// Verdict « silencieux » de Rust (volume intégré non établissable), même texte que l’avis AUDIO_SILENT_KEPT du rapport.
export const NOTICE_SILENT = 'silent';

/** Texte prospectif de l'éditeur ; les messages du rapport restent au passé. */
export function audioLevelMessage(mark, label, t) {
  if (mark.code === NOTICE_SILENT) return t('tree:audio.level.silent', { label });
  if (mark.harmonizeOff) return t('tree:audio.level.nearMuteNoHarmonize', { label });
  switch (mark.code) {
    case NOTICE_NEAR_MUTE_BOOST:
      return t('tree:audio.level.nearMuteBoost', { label });
    case NOTICE_STRONG_LIMITING:
      return t('tree:audio.level.strongLimiting', { label });
    default:
      return '';
  }
}

/**
 * Ce que l'emplacement affiche pour un verdict brut, ou null.
 * `harmonizeOff` : « presque muet » reste signalé, avec un texte adapté ;
 * « faible » disparaît (sans harmonisation, rien n'est amplifié ni écrasé).
 */
export function audioLevelMark(notice, harmonize = true) {
  if (notice === NOTICE_SILENT) return { code: notice, harmonizeOff: !harmonize };
  if (notice === NOTICE_NEAR_MUTE_BOOST) return { code: notice, harmonizeOff: !harmonize };
  if (notice === NOTICE_STRONG_LIMITING && harmonize) return { code: notice, harmonizeOff: false };
  return null;
}

/**
 * Une mesure à la fois : en lancer une nouvelle retire l'ancien verdict et
 * annule la demande précédente. Erreur et résultat périmé (null) : aucun verdict.
 */
export function createAudioLevelWatcher({ measure, onVerdict }) {
  let controller = null;
  return {
    start(path) {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      onVerdict(null);
      Promise.resolve()
        .then(() => measure(path, { signal: current.signal }))
        .then((report) => {
          if (controller !== current || current.signal.aborted) return;
          // Même décision que l’avis de génération (volume intégré non établissable), indépendamment des
          // niveaux LUFS/pic (un pic nul ne suffit pas à conclure au silence).
          onVerdict(report?.silent === true ? NOTICE_SILENT : report?.notice ?? null);
        })
        .catch(() => {});
    },
    stop() {
      controller?.abort();
      controller = null;
    },
  };
}

/** Libellé commun au rapport Rust et à la pastille ; les noms sont des données. */
export function generationLevelLabel(source, t, fallback) {
  if (source?.role === 'root') return t('rust:GENERATION_AUDIO_ROOT_LABEL');
  if (source?.role === 'night') return t('rust:GENERATION_AUDIO_NIGHT_LABEL');
  if (source && 'entry' in source) {
    const name = String(source.entry ?? '').trim();
    const story = name || (source.kind === 'menu'
      ? t('media:usage.label.untitledMenu') : t('media:usage.label.untitledStory'));
    const step = String(source.step ?? '').trim();
    return step ? t('rust:GENERATION_AUDIO_STEP_LABEL', { story, step }) : story;
  }
  if (source && 'stage' in source) {
    return String(source.stage ?? '').trim() || t('rust:GENERATION_AUDIO_UNNAMED_LABEL');
  }
  return fallback;
}
