import WebAudioPlayer from 'wavesurfer.js/dist/webaudio.js';

const PLAYBACK_TICK_MS = 100;
const LOAD_TIMEOUT_MS = 30_000;

let sharedAudioContext = null;

function getAudioContext() {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') return sharedAudioContext;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio indisponible.');
  sharedAudioContext = new AudioContextClass();
  return sharedAudioContext;
}

async function resumeAudioContext(context) {
  if (context?.state === 'suspended') await context.resume();
}

function createWaveSurferWebAudioBackend() {
  return new WebAudioPlayer(getAudioContext());
}

/**
 * Lecteur sans interface basé sur le même backend WebAudio que WaveSurfer.
 *
 * L’adaptateur expose le sous-ensemble de HTMLAudioElement déjà consommé par
 * l’application, afin que les contrôles existants restent indépendants du
 * moteur de décodage.
 */
export class SharedAudioPlayer extends EventTarget {
  constructor(src = '', {
    createBackend = createWaveSurferWebAudioBackend,
    loadTimeoutMs = LOAD_TIMEOUT_MS,
    revokeSourceOnDestroy = false,
  } = {}) {
    super();
    this.backend = createBackend();
    this.loadTimeoutMs = loadTimeoutMs;
    this.revokeSourceOnDestroy = revokeSourceOnDestroy;
    this.ended = false;
    this.preload = 'auto';
    this.onloadedmetadata = null;
    this.ondurationchange = null;
    this.ontimeupdate = null;
    this.onplay = null;
    this.onpause = null;
    this.onended = null;
    this.onerror = null;
    this._src = '';
    this._loadGeneration = 0;
    this._loadTimer = null;
    this._tickTimer = null;
    this._playRequested = false;
    this._readyPromise = Promise.resolve();
    this._unsubscribe = [
      this.backend.addEventListener('loadedmetadata', () => this._handleLoaded()),
      this.backend.addEventListener('play', () => this._handlePlay()),
      this.backend.addEventListener('pause', () => this._handlePause()),
      this.backend.addEventListener('seeking', () => this._emit('timeupdate')),
      this.backend.addEventListener('timeupdate', () => this._emit('timeupdate')),
      this.backend.addEventListener('ended', () => this._handleEnded()),
    ];
    if (src) this.src = src;
  }

  _emit(type) {
    const event = new Event(type);
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }

  _handleLoaded() {
    clearTimeout(this._loadTimer);
    this._loadTimer = null;
    this._resolveReady?.();
    this._readyPromise = Promise.resolve();
    this._resolveReady = null;
    this._rejectReady = null;
    this._emit('loadedmetadata');
    this._emit('durationchange');
  }

  _handlePlay() {
    this.ended = false;
    this._startTicking();
    this._emit('play');
  }

  _handlePause() {
    this._stopTicking();
    this._emit('timeupdate');
    this._emit('pause');
  }

  _handleEnded() {
    this.ended = true;
    this._playRequested = false;
    this._stopTicking();
    this._emit('timeupdate');
    this._emit('ended');
  }

  _startTicking() {
    this._stopTicking();
    this._tickTimer = globalThis.setInterval(() => this._emit('timeupdate'), PLAYBACK_TICK_MS);
  }

  _stopTicking() {
    if (this._tickTimer !== null) globalThis.clearInterval(this._tickTimer);
    this._tickTimer = null;
  }

  get src() {
    return this._src;
  }

  set src(value) {
    const next = String(value || '');
    if (next === this._src) return;
    this.pause();
    this._loadGeneration += 1;
    const generation = this._loadGeneration;
    const previousSource = this._src;
    this._src = next;
    this.ended = false;
    clearTimeout(this._loadTimer);
    this._loadTimer = null;
    this._resolveReady?.();
    this._resolveReady = null;
    this._rejectReady = null;

    if (this.revokeSourceOnDestroy && previousSource?.startsWith('blob:')) {
      URL.revokeObjectURL(previousSource);
    }
    if (!next) {
      this._readyPromise = Promise.resolve();
      this.backend.src = '';
      return;
    }

    const readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
      this._loadTimer = globalThis.setTimeout(() => {
        if (generation !== this._loadGeneration) return;
        const error = new Error('Le décodage audio a expiré.');
        this._resolveReady = null;
        this._rejectReady = null;
        reject(error);
        this._emit('error');
      }, this.loadTimeoutMs);
    });
    // Les lecteurs utilisés uniquement pour obtenir la durée ne passent pas
    // par play(). Leur promesse doit néanmoins être considérée comme gérée.
    readyPromise.catch(() => {});
    this._readyPromise = readyPromise;
    this.backend.src = next;
  }

  get currentSrc() {
    return this._src;
  }

  get paused() {
    return this.backend.paused;
  }

  get currentTime() {
    return this.backend.currentTime;
  }

  set currentTime(value) {
    this.ended = false;
    this.backend.currentTime = Number(value) || 0;
  }

  get duration() {
    return this.backend.duration;
  }

  get volume() {
    return this.backend.volume;
  }

  set volume(value) {
    this.backend.volume = value;
  }

  get muted() {
    return this.backend.muted;
  }

  set muted(value) {
    this.backend.muted = value;
  }

  get playbackRate() {
    return this.backend.playbackRate;
  }

  set playbackRate(value) {
    this.backend.playbackRate = value;
  }

  load() {}

  async play() {
    this._playRequested = true;
    const generation = this._loadGeneration;
    try {
      await this._readyPromise;
      if (!this._playRequested || generation !== this._loadGeneration || !this._src) return;
      await resumeAudioContext(this.backend.audioContext);
      await this.backend.play();
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    }
  }

  pause() {
    this._playRequested = false;
    this.backend.pause();
  }

  destroy() {
    this._playRequested = false;
    this._loadGeneration += 1;
    clearTimeout(this._loadTimer);
    this._loadTimer = null;
    this._resolveReady?.();
    this._resolveReady = null;
    this._rejectReady = null;
    this._stopTicking();
    this._unsubscribe.forEach((unsubscribe) => unsubscribe?.());
    this._unsubscribe = [];
    this.backend.pause();
    const source = this._src;
    this._src = '';
    this.backend.src = '';
    try {
      this.backend.getGainNode().disconnect();
    } catch {
      // Le nœud peut déjà avoir été déconnecté.
    }
    if (this.revokeSourceOnDestroy && source?.startsWith('blob:')) {
      URL.revokeObjectURL(source);
    }
  }
}

export function createAudioPlayer(src, options) {
  return new SharedAudioPlayer(src, options);
}

export function disposeAudioPlayerRef(audioRef) {
  audioRef.current?.destroy?.();
  audioRef.current = null;
}
