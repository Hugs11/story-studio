/** Banners that ask the user to look at the Lunii (same set the panel shows). */
const CHECK_BANNERS = ['damagedTruncated', 'damagedMissingStories', 'damaged', 'resume', 'readOnly', 'orphans'];
const CHECK_STATES = ['damaged', 'readOnly', 'unsupported'];

const plugged = device => !['disconnected', 'ejected'].includes(device.state);
const needsCheck = device => CHECK_STATES.includes(device.state) || (Array.isArray(device.banner) ? device.banner : device.banner ? [device.banner] : []).some(kind => CHECK_BANNERS.includes(kind));

/**
 * Status of the connected Lunii for the catalogue bar: none (neutral), ready (readable)
 * or check (damaged list, read-only, unreadable, orphans...). Built from the states the panel already computes.
 */
export function luniiStatus(devices = [], activeId = null) {
  const connected = devices.filter(plugged);
  const shown = devices.find(d => d.id === activeId) ?? devices[0] ?? null;
  const present = devices.length > 0;
  if (!connected.length) return { kind: 'none', count: 0, name: null, hasPanel: present };
  const active = connected.find(d => d.id === activeId) ?? connected[0];
  return { kind: connected.some(needsCheck) ? 'check' : 'ready', count: connected.length, name: active.name || null, hasPanel: present && Boolean(shown) };
}
