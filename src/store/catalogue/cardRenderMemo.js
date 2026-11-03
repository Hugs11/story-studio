// Re-render rule of the catalogue cards and rows.
//
// The browser rebuilds its `view` object on every render (scroll frames,
// selection, busy state, list reloads). Cards are memoized against what they
// really show: their own item, their own state in the shared sets (active,
// selected, expanded, on the Lunii, dragged, send button) and the other view
// values by identity. Handlers come from `stableCardView`, so a card skipped
// by the memo still calls the latest browser handlers.

/** The browser's view of the current render, kept for per-card comparisons. */
export const RAW_VIEW = Symbol('catalogueRawView');

// Values cards and rows never read: the window geometry, the open menu, the
// list container and column widths (applied by <col>, not by the rows).
const IGNORED = new Set(['window', 'menu', 'containerRef', 'listColumns']);
// Shared collections reduced to the card's own membership.
const PER_CARD = {
  activeId: (view, id) => view.activeId === id,
  selected: (view, id) => Boolean(view.selected?.has(id)),
  expanded: (view, id) => Boolean(view.expanded?.has(id)),
  luniiFicheIds: (view, id) => Boolean(view.luniiFicheIds?.has(id)),
};

function sendSignature(view, card) {
  const send = (view[RAW_VIEW] ?? view).luniiSend;
  if (!send) return '';
  const state = send.stateOf?.(card) ?? null;
  const target = entry => entry ? [entry.device?.id, entry.device?.name, entry.presence?.position, entry.presence?.hidden, entry.refusal] : null;
  return JSON.stringify([Boolean(send.drag), Boolean(send.drag?.dragIds?.has(card.id)), state?.kind, state?.reasonKey, state?.refusal,
    target(state?.target), (state?.targets ?? []).map(target)]);
}

/** `React.memo` comparator shared by the grid cards and the list rows. */
export function sameCardProps(prev, next) {
  if (prev.item !== next.item || prev.index !== next.index || prev.dragSource !== next.dragSource || prev.columns !== next.columns) return false;
  const a = prev.view;
  const b = next.view;
  if (a === b) return true;
  const card = next.item.card;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (IGNORED.has(key)) continue;
    if (Object.hasOwn(PER_CARD, key)) { if (PER_CARD[key](a, card.id) !== PER_CARD[key](b, card.id)) return false; continue; }
    if (key === 'luniiSend') { if (sendSignature(a, card) !== sendSignature(b, card)) return false; continue; }
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function resolve(view, path) {
  let value = view;
  for (const key of path) value = value?.[key];
  return value;
}

/**
 * Same values as `view`, with every top-level handler (and those of
 * `luniiSend`) replaced by a delegate that is stable across renders and calls
 * the handler of the latest view. `cache` holds the delegates; `latest` is a
 * ref updated by the caller on every render.
 */
export function stableCardView(view, latest, cache) {
  const delegate = path => {
    const name = path.join('.');
    let fn = cache.get(name);
    if (!fn) {
      fn = (...args) => resolve(latest.current, path)?.(...args);
      cache.set(name, fn);
    }
    return fn;
  };
  const stable = { [RAW_VIEW]: view };
  for (const [key, value] of Object.entries(view)) {
    if (typeof value === 'function') stable[key] = delegate([key]);
    else if (key === 'luniiSend' && value) {
      stable[key] = Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, typeof inner === 'function' ? delegate([key, name]) : inner]));
    } else stable[key] = value;
  }
  return stable;
}
