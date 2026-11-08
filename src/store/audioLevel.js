// Single boundary for current-source analysis. null means the source changed
// during measurement: discard it silently (it must never display an error).
// AbortSignal rejects with AbortError. Aborted queued work never invokes Rust;
// an already invoked analysis keeps its slot until the engine finishes it.
export function createAudioLevelApi(bridge = {}) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      job.started = true;
      active += 1;
      (async () => {
        try {
          const invoke = bridge.invoke ?? (await import('@tauri-apps/api/core')).invoke;
          // The dynamic import is another point at which cancellation can win.
          job.signal?.throwIfAborted();
          job.resolve(await invoke('measure_audio_level', { path: job.path }));
        } catch (error) {
          job.reject(error);
        } finally {
          job.signal?.removeEventListener('abort', job.abort);
          active -= 1;
          drain();
        }
      })();
    }
  }
  return {
    measureAudioLevel(path, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const job = { path, signal, resolve, reject, started: false };
        job.abort = () => {
          if (!job.started) {
            queue.splice(queue.indexOf(job), 1);
            signal.removeEventListener('abort', job.abort);
          }
          reject(new DOMException('Audio analysis aborted', 'AbortError'));
        };
        if (signal?.aborted) {
          reject(new DOMException('Audio analysis aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job);
        drain();
      });
    },
  };
}
export const { measureAudioLevel } = createAudioLevelApi();
