import { LuniiIcon } from '../../icons/LuniiIcon.jsx';
import { writeReason } from './LuniiStoryMenu.jsx';
import { useCallback, useRef } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { LUNII_PANEL_WIDTH, luniiSelection, luniiSelectAll, luniiRows } from '../../../store/catalogue/luniiDevices.js';
import { mergeSendingRows } from '../../../store/catalogue/luniiSend.js';
import { LuniiSendingRow } from './LuniiSendingRow.jsx';
import { PanelResizeHandle } from '../../structure/PanelResizeHandle.jsx';
import { Button } from '../../common/Button.jsx';
import { PanelLeftOpen } from '../../icons/LucideLocal.jsx';
import { LuniiPanelHeader } from './LuniiPanelHeader.jsx';
import { LuniiStoryRow } from './LuniiStoryRow.jsx';
import { LuniiBanner } from './LuniiBanner.jsx';
import { LuniiEmptyState } from './LuniiEmptyState.jsx';
import './LuniiPanel.css';
import { Tooltip } from '../../common/Tooltip.jsx';

// Only text entry keeps its own keys; a focused checkbox still drives the shortcuts.
function textEntry(target) {
  const field = target?.closest?.('input, textarea, [contenteditable="true"], [role="menu"]');
  return !!field && !(field.tagName === 'INPUT' && ['checkbox', 'radio'].includes(field.type));
}

export function LuniiPanel({ lunii, onSelect, onDeviceChange, dnd = null, width = { value: lunii.luniiPanelWidth, max: lunii.luniiPanelWidth } }) {
  const { t } = useCatalogueTranslation();
  const devices = lunii.luniiDevices;
  const device = devices.find(d => d.id === lunii.activeLuniiId) ?? devices[0];
  const panelRef = useRef(null);
  const anchor = useRef(null);
  const measureRef = width.panelRef;
  // React detaches the ref before removing the host node, while focus is still inside.
  const setPanelRef = useCallback(node => {
    if (!node && panelRef.current?.contains(document.activeElement)) {
      requestAnimationFrame(() => document.getElementById('catalogue-search')?.focus());
    }
    panelRef.current = node;
    if (measureRef) measureRef.current = node;
  }, [measureRef]);
  if (!device) return null;
  const rows = luniiRows(device);
  const send = lunii.send;
  const shownRows = mergeSendingRows(rows, send?.virtualFor(device.id) ?? []);
  const hovered = send?.over?.deviceId === device.id ? send.over : null;
  // A refused drag (official stories only) neither highlights the list nor inserts anything.
  const overHere = hovered && !hovered.refused ? hovered : null;
  const collapsed = lunii.luniiPanelCollapsed;
  const panelWidth = Math.max(LUNII_PANEL_WIDTH.min, width.value);
  const empty = ['detected', 'opening', 'unsupported', 'ejected', 'disconnected'].includes(device.state);
  const bannerSet = new Set(Array.isArray(device.banner) ? device.banner : device.banner ? [device.banner] : []);
  const banners = ['damagedTruncated', 'damagedMissingStories', 'damaged', 'resume', 'readOnly', 'orphans'].filter(kind => bannerSet.has(kind));
  const readOnlyReason = writeReason(device, t);
  const ids = lunii.selection.side === 'lunii' ? lunii.selection.ids : [];
  const select = (key, event) => { const next = luniiSelection(rows, ids, key, event, anchor.current ?? key); if (!event?.shiftKey) anchor.current = key; onSelect(next); };
  const reorder = dnd?.reorder ?? null;
  return <aside data-lunii-drop={collapsed ? 'collapsed' : undefined} data-device-id={collapsed ? device.id : undefined} onKeyDown={event => {
    if (textEntry(event.target) || reorder) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); onSelect(luniiSelectAll(rows)); }
    else if (event.key === 'Delete') { event.preventDefault(); void lunii.gestures?.remove(device, rows.filter(s => ids.includes(s.key)), true); }
    else if (event.key === 'Escape') onSelect([]);
    else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && ids.length) {
      event.preventDefault(); void lunii.gestures?.move(device, ids, event.key === 'ArrowUp' ? -1 : 1);
    }
  }} ref={setPanelRef} className={`lunii-panel ${collapsed ? 'is-collapsed' : ''} ${overHere ? 'is-drop-target' : ''} ${hovered?.refused ? 'is-drop-refused' : ''}`} aria-label={t('catalogue:lunii.panel')} style={{ width: collapsed ? 48 : panelWidth, minWidth: collapsed ? 48 : LUNII_PANEL_WIDTH.min }}>
    <span className="catalogue-visually-hidden" aria-live="polite" aria-atomic="true">{lunii.gestures?.announcement}</span>
    {collapsed ? <><Button id="lunii-panel-expand" variant="icon" aria-label={t('catalogue:lunii.expand')} onClick={() => { lunii.store.collapse(false); requestAnimationFrame(() => document.getElementById('lunii-panel-collapse')?.focus()); }}><PanelLeftOpen width={18} height={18} /></Button>
      {devices.map(d => <Tooltip key={d.id} text={d.name || t('catalogue:lunii.name')} asChild wrap><Button variant="icon" aria-label={d.name || t('catalogue:lunii.name')} data-lunii-drop="collapsed" data-device-id={d.id} onClick={() => { onDeviceChange(d.id); lunii.store.collapse(false); }}><LuniiIcon width={22} height={22} /><small>{d.stories.length}</small></Button></Tooltip>)}</>
      : <>
        {devices.length >= 2 && <div className="lunii-tabs" role="tablist" aria-label={t('catalogue:lunii.panel')}>
          {devices.map((d, index) => <button type="button" role="tab" key={d.id} id={`lunii-tab-${d.id}`} aria-controls="lunii-tabpanel" aria-selected={d.id === device.id} tabIndex={d.id === device.id ? 0 : -1}
            data-lunii-drop="tab" data-device-id={d.id} onClick={() => onDeviceChange(d.id)} onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index + 1) % devices.length : event.key === 'ArrowLeft' ? (index + devices.length - 1) % devices.length : event.key === 'Home' ? 0 : event.key === 'End' ? devices.length - 1 : null;
              if (next !== null) { event.preventDefault(); onDeviceChange(devices[next].id); document.getElementById(`lunii-tab-${devices[next].id}`)?.focus(); }
            }}>{d.name || t('catalogue:lunii.name')}</button>)}
        </div>}
        <div id="lunii-tabpanel" role={devices.length >= 2 ? 'tabpanel' : undefined} aria-labelledby={devices.length >= 2 ? `lunii-tab-${device.id}` : undefined} className="lunii-tabpanel">
          <LuniiPanelHeader key={device.id} gestures={lunii.gestures} device={device} gauge={overHere} onCollapse={() => { lunii.store.collapse(true); requestAnimationFrame(() => document.getElementById('lunii-panel-expand')?.focus()); }} onEject={() => void lunii.store.eject(device.id)} />
          <div className="lunii-scroll" data-lunii-drop="scroll" data-device-id={device.id}>{empty ? <LuniiEmptyState state={device.state} busy={device.busy} onOpen={() => void lunii.store.inspect(device.id, true)} /> : <>
            {banners.map(kind => <LuniiBanner key={kind} kind={kind} device={device} gestures={lunii.gestures} />)}
            {shownRows.length ? <div className={`lunii-stories ${device.state === 'damaged' ? 'is-damaged' : ''}`} role="grid" aria-label={t('catalogue:lunii.panel')} aria-multiselectable="true">
              {shownRows.map(story => story.sending ? <LuniiSendingRow key={story.key} story={story} /> : <LuniiStoryRow key={story.key} story={story} disabledReason={readOnlyReason} selected={lunii.selection.side === 'lunii' && lunii.selection.ids.includes(story.key)} device={device} gestures={lunii.gestures} onSelect={event => select(story.key, event)}
                dragging={reorder?.keys.includes(story.key)} insertion={dnd?.insertion === story.key || (overHere?.rowKey === story.key)} />)}
              {overHere && overHere.rowKey === null && <div className="lunii-insertion-end" aria-hidden="true" />}
            </div> : <LuniiEmptyState />}
          </>}</div>
        </div>
        <PanelResizeHandle ariaLabel={t('catalogue:lunii.resize')} panelClass=".lunii-panel" minWidth={LUNII_PANEL_WIDTH.min} maxWidth={Math.max(LUNII_PANEL_WIDTH.min, width.max)} value={panelWidth} defaultValue={LUNII_PANEL_WIDTH.initial} onResize={lunii.store.resize} />
      </>}
  </aside>;
}
