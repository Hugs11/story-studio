// A mounted checker and every outstanding native task retain the input. The
// microtask also makes React's effect setup/cleanup replay non-destructive.
export function createCheckerPreparationLifetime(release, onError = () => {}) {
  let owners = 0; let tasks = 0; let released = false;
  function settle() {
    queueMicrotask(() => {
      if (owners || tasks || released) return;
      released = true;
      Promise.resolve().then(release).catch(onError);
    });
  }
  return {
    retain() {
      if (released) throw new Error('Checker preparation already released');
      owners += 1; let finished = false;
      return () => { if (!finished) { finished = true; owners -= 1; settle(); } };
    },
    beginTask() {
      if (released) throw new Error('Checker preparation already released');
      tasks += 1; let finished = false;
      return () => { if (!finished) { finished = true; tasks -= 1; settle(); } };
    },
  };
}
