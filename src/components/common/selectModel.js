// Logique pure de la liste déroulante de l'app (`Select.jsx`) : recherche par frappe,
// déplacement parmi les options actives, groupes et placement de la liste. Aucun DOM ici.

// Comparaison sans casse ni accents : « é » et « E » se trouvent par « e ».
export function foldText(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Options consécutives de même `group` → une section ; sans `group`, une section anonyme.
// `index` est la position de l'option dans la liste à plat (celle du clavier et d'ARIA).
export function buildSections(options) {
  const sections = [];
  options.forEach((option, index) => {
    const group = option.group ?? null;
    const last = sections[sections.length - 1];
    if (last && last.group === group) last.options.push({ option, index });
    else sections.push({ group, options: [{ option, index }] });
  });
  return sections;
}

export const isEnabled = option => !option.disabled;

export function firstEnabled(options) {
  return options.findIndex(isEnabled);
}

export function lastEnabled(options) {
  for (let index = options.length - 1; index >= 0; index--) if (isEnabled(options[index])) return index;
  return -1;
}

// Option active à l'ouverture : la valeur courante si elle est choisissable, sinon la première active.
export function initialActive(options, value) {
  const current = options.findIndex(option => Object.is(option.value, value));
  return current >= 0 && isEnabled(options[current]) ? current : firstEnabled(options);
}

// Déplacement de `step` options actives (négatif = vers le haut), borné aux extrémités.
export function moveActive(options, from, step) {
  if (step === 0) return from;
  const direction = Math.sign(step);
  let remaining = Math.abs(step);
  let index = from;
  for (let next = from + direction; next >= 0 && next < options.length; next += direction) {
    if (!isEnabled(options[next])) continue;
    index = next;
    if (--remaining === 0) break;
  }
  return index;
}

export const TYPEAHEAD_RESET_MS = 500;

// Frappe accumulée : retourne le nouveau tampon (réinitialisé après `TYPEAHEAD_RESET_MS`).
export function extendBuffer(state, char, now) {
  const fresh = !state || now - state.at > TYPEAHEAD_RESET_MS;
  return { text: (fresh ? '' : state.text) + char, at: now };
}

// Index de l'option à viser pour le tampon, ou -1. Un tampon d'une seule lettre, ou de la même lettre
// répétée, passe à l'option suivante qui commence par elle (cycle) ; sinon préfixe, à partir de l'option courante.
export function typeaheadMatch(options, buffer, current) {
  const chars = [...foldText(buffer)];
  if (chars.length === 0 || options.length === 0) return -1;
  const cycle = chars.every(char => char === chars[0]);
  const needle = cycle ? chars[0] : chars.join('');
  const start = cycle ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < options.length; step++) {
    const index = (start + step) % options.length;
    const option = options[index];
    if (isEnabled(option) && foldText(option.label).startsWith(needle)) return index;
  }
  return -1;
}

// Placement de la liste (position `fixed`) : sous le champ, retournée au-dessus s'il manque de la place
// et qu'il y en a davantage au-dessus ; hauteur bornée à la place disponible.
export function placeList({ rect, listWidth, contentHeight, viewport, gap = 4, margin = 8, maxHeight = 320 }) {
  const below = viewport.height - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const wanted = Math.min(contentHeight, maxHeight);
  const flip = below < wanted && above > below;
  const room = Math.max(80, flip ? above : below);
  const height = Math.min(wanted, room);
  const left = Math.max(margin, Math.min(rect.left, viewport.width - margin - listWidth));
  return {
    left,
    top: flip ? rect.top - gap - height : rect.bottom + gap,
    maxHeight: Math.min(maxHeight, room),
    minWidth: rect.width,
    above: flip,
  };
}
