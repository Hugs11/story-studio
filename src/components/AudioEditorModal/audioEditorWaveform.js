// Helpers purs pour la waveform de l'editeur audio.
// Extraits de AudioEditorModal.jsx pour reduire la surface de l'orchestrateur.

export function createAudioEditorWaveformOptions({ container, url, plugins }) {
  return {
    container,
    url,
    waveColor: '#64748B',
    progressColor: '#94A3B8',
    cursorColor: '#F59E0B',
    height: 96,
    plugins,
    interact: true,
    dragToSeek: true,
    hideScrollbar: false,
    // Important pour l'editeur : la waveform, le curseur et le son doivent
    // utiliser le meme decode. Le backend MediaElement peut diverger sur des
    // MP3 VBR ou remplaces apres trim/cut, ce qui decale visuel et audio.
    backend: 'WebAudio',
    sampleRate: 44100,
  };
}

// Construit un AudioBuffer inverse pour le playback shuttle arriere (Web Audio
// ne supporte pas une playbackRate negative -- on cree donc un buffer reverse
// qu'on lit en avant). Pas de dependance au contexte qui le cree autrement
// que pour `createBuffer`.
export function createReverseBuffer(buffer, audioContext) {
  if (!buffer || !audioContext) return null;
  const reversed = audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel);
    const output = reversed.getChannelData(channel);
    for (let i = 0, j = input.length - 1; i < input.length; i += 1, j -= 1) {
      output[i] = input[j];
    }
  }
  return reversed;
}

// Marque les poignees gauche/droite d'une region wavesurfer avec une couleur de
// bord et un dataset d'identification, apres le prochain tick (le DOM doit etre
// monte).
export function styleRegionHandles(region, color) {
  window.setTimeout(() => {
    const left = region?.element?.querySelector?.('[part*="region-handle-left"]');
    const right = region?.element?.querySelector?.('[part*="region-handle-right"]');
    if (left) {
      left.style.borderLeftColor = color;
      left.dataset.audioEditorRegionId = region.id ?? '';
      left.dataset.audioEditorHandle = 'left';
    }
    if (right) {
      right.style.borderRightColor = color;
      right.dataset.audioEditorRegionId = region.id ?? '';
      right.dataset.audioEditorHandle = 'right';
    }
  }, 0);
}
