export const pattern = value => value instanceof RegExp ? { regex: value.source, flags: value.flags } : { text: String(value) };

// Fonction autonome exécutée dans la WebView. Sous-ensemble inventorié :
// CSS (+ :visible), button/menuitem/dialog/alertdialog, noms aria-label,
// aria-labelledby, texte/title, exact ou RegExp, hasText et has relatif.
// Pas de moteur ARIA complet (accname SVG, shadow DOM, pseudo-rôles), XPath,
// sélecteurs Playwright internes, hasNot ou includeHidden.
export function resolveElements(chain, roots = [document]) {
  const normalize = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const matches = (text, p, exact = false) => !p || (p.regex !== undefined
    ? new RegExp(p.regex, p.flags).test(normalize(text))
    : exact ? normalize(text) === normalize(p.text) : normalize(text).includes(normalize(p.text)));
  const visible = el => {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  };
  const accessible = el => !el.closest('[aria-hidden="true"]') && visible(el);
  const name = el => el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
    || el.textContent?.trim() || el.getAttribute('title') || '';
  const role = el => el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : null);
  const resolve = (steps, start) => {
    let elements = start;
    for (const step of steps) {
      if (step.kind === 'nth') { elements = elements.slice(step.index, step.index + 1); continue; }
      if (step.kind === 'filter') {
        elements = elements.filter(el => matches(el.textContent, step.text)
          && (!step.has || resolve(step.has, [el]).length));
        continue;
      }
      const candidates = [...new Set(elements.flatMap(el => Array.from(el.querySelectorAll(
        step.kind === 'css' ? step.selector.replace(/:visible\b/g, '')
          : step.kind === 'role' ? (step.role === 'button' ? 'button, [role="button"]' : `[role="${step.role}"]`) : '*'))))];
      elements = candidates.filter(el => {
        if (step.kind === 'css') return !step.selector.includes(':visible') || visible(el);
        if (step.kind === 'role') return role(el) === step.role && accessible(el) && matches(name(el), step.name, step.exact);
        if (step.kind === 'text') {
          if (!matches(el.textContent, step.text, step.exact)) return false;
          // Comme getByText : élément le plus profond portant le texte.
          return !Array.from(el.children).some(child => matches(child.textContent, step.text, step.exact));
        }
        throw new Error(`Sélecteur e2e inconnu : ${step.kind}`);
      });
    }
    return elements;
  };
  return resolve(chain, roots);
}
