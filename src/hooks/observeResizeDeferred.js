/** Observe `targets`; run `measure` on the next animation frame (never inside the observer
 *  delivery, which would loop). Returns a disposer that also cancels the pending frame. */
export function observeResizeDeferred(targets, measure) {
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; measure(); });
  });
  for (const target of targets) observer.observe(target);
  return () => { cancelAnimationFrame(frame); observer.disconnect(); };
}
