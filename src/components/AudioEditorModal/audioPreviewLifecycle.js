export function createAudioPreviewLifecycle({
  discardResult,
  onPendingChange,
  onError,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let active = true;
  let generation = 0;
  let timer = null;
  let pending = false;

  function setPending(next) {
    if (pending === next) return;
    pending = next;
    if (active) onPendingChange(next);
  }

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  async function execute(token, task) {
    try {
      const result = await task.produce();
      if (!active || token !== generation) {
        await discardResult(result);
        return { status: 'stale', result };
      }
      task.apply(result);
      if (token === generation) setPending(false);
      return { status: 'applied', result };
    } catch (error) {
      if (!active || token !== generation) {
        return { status: 'stale-error', error };
      }
      onError(error);
      setPending(false);
      return { status: 'error', error };
    }
  }

  function run(task) {
    cancelTimer();
    const token = ++generation;
    setPending(true);
    return execute(token, task);
  }

  function debounce(task, delayMs) {
    cancelTimer();
    const token = ++generation;
    setPending(true);
    timer = setTimer(() => {
      timer = null;
      void execute(token, task);
    }, delayMs);
    return token;
  }

  function invalidate() {
    generation += 1;
    cancelTimer();
    setPending(false);
  }

  function dispose() {
    active = false;
    generation += 1;
    cancelTimer();
    pending = false;
  }

  return {
    run,
    debounce,
    invalidate,
    dispose,
    isPending: () => pending,
  };
}
