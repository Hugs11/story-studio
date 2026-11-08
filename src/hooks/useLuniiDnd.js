import { useCallback, useEffect, useRef, useState } from 'react';
import { reorderedKeys } from '../store/catalogue/luniiDevices.js';
import { repatriatePlan } from '../store/catalogue/luniiRepatriate.js';
import { dropTargetOf, edgeScrollSpeed, pinScrollAncestors, probePoint, reorderIndex, sendRowKey } from '../store/catalogue/luniiDndTargets.js';

const elementUnder = (x, y) => (typeof document === 'undefined' ? null : document.elementFromPoint(x, y));

/**
 * The handlers of the one DndContext that covers the catalogue and the Lunii
 * panel: a card (or the selection it belongs to) dragged to the panel, and a
 * story handle dragged inside the panel to reorder. The rules stay where they
 * were: `useLuniiSend` (insertion, gauge, send) and `lunii.gestures.reorder`.
 * Hovered surfaces are read through `dropTargetOf`; `elementAt` is injectable.
 */
export function useLuniiDnd({ lunii, sendUi, onDeviceChange, elementAt = elementUnder }) {
  const [reorder, setReorder] = useState(null);
  const [insertion, setInsertion] = useState(null);
  const [active, setActive] = useState(null);
  const [repatriation, setRepatriation] = useState(null);
  const latest = useRef({});
  latest.current = { lunii, sendUi, onDeviceChange, elementAt };
  const source = useRef(null);
  const point = useRef(null);
  const frame = useRef(null);
  const pointer = useRef(null);
  const lastKey = useRef(undefined);
  const unpin = useRef(null);

  const deviceOf = id => latest.current.lunii?.luniiDevices?.find(device => device.id === id) ?? null;
  // What dropping the dragged story handles on the catalogue would do (also the refusal, if any).
  const planFor = src => {
    const device = deviceOf(src.deviceId);
    return device ? repatriatePlan(device, src.keys.map(key => device.stories.find(story => story.key === key)).filter(Boolean)) : null;
  };

  const apply = useCallback(hit => {
    const src = source.current;
    if (!src) return;
    // Same target as the last applied one: nothing to update (no setState at all).
    const key = hit ? `${hit.kind}|${hit.deviceId}|${hit.rowKey}` : '';
    if (key === lastKey.current) return;
    lastKey.current = key;
    const send = latest.current.lunii?.send;
    if (src.kind === 'card') {
      const device = hit ? deviceOf(hit.deviceId) : null;
      if (!device || !send?.hover(device, sendRowKey(hit), src.ids)) send?.leave();
    } else {
      const device = deviceOf(src.deviceId);
      // Row keys mark insert-before; the numeric final boundary marks insert-at-end.
      const endIndex = hit?.kind === 'end' ? reorderIndex(hit, device) : null;
      const changesOrder = endIndex != null && reorderedKeys(device.stories, src.keys, endIndex).some((key, i) => key !== device.stories[i].key);
      setInsertion(changesOrder ? device.stories.length
        : hit?.kind === 'row' && hit.deviceId === src.deviceId ? hit.rowKey : null);
      setRepatriation(hit?.kind === 'catalogue' ? planFor(src) : null);
    }
  }, []);

  const stopScroll = useCallback(() => { if (frame.current != null) cancelAnimationFrame(frame.current); frame.current = null; }, []);
  // Both sources use the same list-under-pointer scroll and hit-test loop.
  const scrollTick = useCallback(() => {
    frame.current = null;
    const p = point.current;
    if (!p || !source.current) return;
    apply(dropTargetOf(latest.current.elementAt(p.x, p.y)));
    if (source.current.keyboard) return;
    const list = latest.current.elementAt(p.x, p.y)?.closest?.('.lunii-scroll');
    const speed = list?.getBoundingClientRect ? edgeScrollSpeed(list.getBoundingClientRect(), p.y) : 0;
    if (!speed) return;
    const previous = list.scrollTop;
    list.scrollTop += speed;
    if (list.scrollTop === previous) return;
    lastKey.current = undefined; // the list moved under a still pointer: re-read the target
    apply(dropTargetOf(latest.current.elementAt(p.x, p.y)));
    frame.current = requestAnimationFrame(scrollTick);
  }, [apply]);

  const release = useCallback(() => { unpin.current?.(); unpin.current = null; }, []);
  const finish = useCallback(() => {
    stopScroll(); release();
    source.current = null; point.current = null; pointer.current = null; lastKey.current = undefined;
    setReorder(null); setInsertion(null); setActive(null); setRepatriation(null);
  }, [stopScroll, release]);

  useEffect(() => () => { stopScroll(); release(); }, [stopScroll, release]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    // dnd-kit deltas include ancestor scroll compensation, so they cannot locate
    // a physical pointer after wheel/edge scrolling. Keep viewport coordinates.
    const move = event => {
      if (source.current && !pointer.current) return;
      pointer.current = { x: event.clientX, y: event.clientY };
      if (source.current) {
        point.current = pointer.current;
        if (frame.current == null) frame.current = requestAnimationFrame(scrollTick);
      }
    };
    const scroll = () => {
      if (source.current && frame.current == null) frame.current = requestAnimationFrame(scrollTick);
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', move, true);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', move, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [scrollTick]);

  const onDragStart = useCallback(event => {
    const data = event.active?.data?.current;
    pointer.current = Number.isFinite(event.activatorEvent?.clientX) ? pointer.current ?? { x: event.activatorEvent.clientX, y: event.activatorEvent.clientY } : null;
    point.current = pointer.current;
    const { lunii: state, sendUi: ui } = latest.current;
    if (data?.kind === 'card') {
      const ids = ui?.drag?.idsFor ? ui.drag.idsFor(data.cardId) : [data.cardId];
      lastKey.current = undefined;
      source.current = { kind: 'card', ids };
      // Only the panel list moves under a card: the catalogue it left stays put.
      unpin.current?.(); unpin.current = pinScrollAncestors(event.activatorEvent?.target);
      setActive({ kind: 'card', count: ids.length, title: data.title ?? '' });
      state?.send?.startDrag(ids);
    } else if (data?.kind === 'lunii-row') {
      const device = deviceOf(data.deviceId);
      const selected = state?.selection?.side === 'lunii' ? state.selection.ids : [];
      const keys = selected.includes(data.key) ? selected.filter(key => device?.stories.some(story => story.key === key)) : [data.key];
      lastKey.current = undefined;
      source.current = { kind: 'row', deviceId: data.deviceId, keys, keyboard: event.activatorEvent?.type === 'keydown' };
      setReorder({ deviceId: data.deviceId, keys });
      setActive({ kind: 'row', count: keys.length, title: data.title ?? '' });
    }
  }, []);

  const onDragMove = useCallback(event => {
    if (!source.current) return;
    point.current = pointer.current ?? probePoint(event);
    if (typeof requestAnimationFrame !== 'function') { apply(point.current ? dropTargetOf(latest.current.elementAt(point.current.x, point.current.y)) : null); return; }
    if (frame.current == null) frame.current = requestAnimationFrame(scrollTick);
  }, [apply, scrollTick]);

  const onDragEnd = useCallback(event => {
    const src = source.current;
    const p = pointer.current ?? probePoint(event) ?? point.current;
    const hit = p ? dropTargetOf(latest.current.elementAt(p.x, p.y)) : null;
    const { lunii: state, onDeviceChange: change } = latest.current;
    if (src?.kind === 'card') {
      const device = hit ? deviceOf(hit.deviceId) : null;
      if (device) {
        void state.send.drop(device, sendRowKey(hit), src.ids);
        if (hit.kind === 'tab') change?.(hit.deviceId);
      } else state?.send?.endDrag();
    } else if (src?.kind === 'row') {
      const device = deviceOf(src.deviceId);
      const index = reorderIndex(hit, device);
      if (index != null) void state.gestures?.reorder(device, src.keys, index);
      else if (hit?.kind === 'catalogue') {
        const plan = planFor(src);
        if (plan?.eligible.length) void state.gestures?.repatriate(device, plan.eligible);
      }
    }
    finish();
  }, [finish]);

  const onDragCancel = useCallback(() => {
    if (source.current?.kind === 'card') latest.current.lunii?.send?.endDrag();
    finish();
  }, [finish]);

  return { reorder, insertion, active: active && repatriation ? { ...active, repatriation } : active, repatriation, handlers: { onDragStart, onDragMove, onDragEnd, onDragCancel } };
}
