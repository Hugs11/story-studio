/**
 * Where a drag is hovering, read from the DOM instead of registered drop
 * zones: every Lunii surface that accepts a drop carries `data-lunii-drop`
 * (+ `data-device-id`, and `data-row-key` for a story row). This keeps the
 * panel components free of drag hooks and gives pointer and keyboard drags the
 * same single source of truth.
 *
 * Kinds: `row` (insert before that story), `orphan` / `header` / `scroll` /
 * `tab` / `collapsed` (end of the device's list). Only `row` and `header`
 * take a reorder drop. `catalogue` is the catalogue's own results area: dropping
 * Lunii stories there repatriates them.
 */
export function dropTargetOf(element) {
  const node = element?.closest?.('[data-lunii-drop]');
  if (!node) return null;
  const data = node.dataset ?? {};
  return { kind: data.luniiDrop, deviceId: data.deviceId ?? null, rowKey: data.luniiDrop === 'row' ? data.rowKey ?? null : null };
}

/** Row key a send must be inserted before; null means the end of the list. */
export const sendRowKey = target => (target?.kind === 'row' ? target.rowKey : null);

/** Index a reorder drop lands on, or null when this spot does not accept it. */
export function reorderIndex(target, device) {
  if (!target || !device || target.deviceId !== device.id) return null;
  if (target.kind === 'header') return device.stories.length;
  if (target.kind !== 'row') return null;
  const index = device.stories.findIndex(story => story.key === target.rowKey);
  return index < 0 ? null : index;
}

/**
 * Point under the dragged thing: the pointer for a pointer drag, the centre of
 * the moved handle for a keyboard drag.
 */
export function probePoint({ activatorEvent, delta, active } = {}) {
  if (Number.isFinite(activatorEvent?.clientX) && Number.isFinite(activatorEvent?.clientY)) {
    return { x: activatorEvent.clientX + (delta?.x ?? 0), y: activatorEvent.clientY + (delta?.y ?? 0) };
  }
  const rect = active?.rect?.current?.translated;
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
}

/** Scroll step (px per frame) when the pointer is within the edge zone of a list; 0 elsewhere. */
export function edgeScrollSpeed(rect, y, zone = 36) {
  if (!rect || !Number.isFinite(y)) return 0;
  if (y < rect.top + zone) return -Math.ceil((rect.top + zone - y) / 4);
  if (y > rect.bottom - zone) return Math.ceil((y - (rect.bottom - zone)) / 4);
  return 0;
}

/**
 * Holds every scrollable ancestor of a dragged card (a Lunii list excepted) at
 * its position until the returned release is called. WebKit and Chromium scroll
 * the pressed area when the held pointer leaves it (onto the status bar, say),
 * even under `user-select: none`; a scroll event runs before the next paint, so
 * putting the position back there never shows the jump.
 */
export function pinScrollAncestors(start, view = globalThis.window) {
  const pinned = [];
  for (let el = start?.nodeType === 1 ? start : start?.parentElement; el; el = el.parentElement) {
    if (el.classList?.contains('lunii-scroll')) continue;
    const style = view?.getComputedStyle?.(el);
    if (!style || !/auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const top = el.scrollTop, left = el.scrollLeft;
    const hold = () => { if (el.scrollTop !== top) el.scrollTop = top; if (el.scrollLeft !== left) el.scrollLeft = left; };
    el.addEventListener('scroll', hold);
    pinned.push([el, hold]);
  }
  return () => pinned.forEach(([el, hold]) => el.removeEventListener('scroll', hold));
}
