export function needsWebAudioPlayback(path) {
  const name = String(path || '').replace(/[?#].*$/, '').split(/[\\/]/).pop() || '';
  return name.toLowerCase().endsWith('.flac');
}

export function createAudioFieldWebAudioOptions(container) {
  return {
    container,
    backend: 'WebAudio',
    height: 1,
    width: 1,
    interact: false,
    autoScroll: false,
    autoCenter: false,
    sampleRate: 44100,
  };
}

export function stopAudioFieldWebAudio(player, reset = false) {
  if (!player) return;
  try {
    player.pause();
    if (reset) player.setTime(0);
  } catch {
    // The Web Audio backend may already have been torn down.
  }
}

export function disposeAudioFieldWebAudio(player) {
  if (!player) return;
  try {
    player.pause();
  } catch {
    // The Web Audio backend may already have been torn down.
  }
  try {
    player.destroy();
  } catch {
    // Destruction is idempotent from the field lifecycle point of view.
  }
}
