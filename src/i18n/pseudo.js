// Préserver les paramètres et balises nommées tout en étirant la prose.
export function pseudoText(value) {
  const accents = { a: 'à', e: 'ë', i: 'ï', o: 'ô', u: 'ü', A: 'À', E: 'Ë', I: 'Ï', O: 'Ô', U: 'Ü' };
  let length = 0;
  const text = value.split(/({{[^}]+}}|<[^>]+>)/g).map((part) => {
    if (/^({{|<)/.test(part)) return part;
    length += [...part].length;
    return part.replace(/[aeiouAEIOU]/g, (letter) => accents[letter]);
  }).join('');
  return `[${text}${'~'.repeat(Math.ceil(length * 0.35))}]`;
}

export function pseudoResources(resources) {
  return Object.fromEntries(Object.entries(resources).map(([key, value]) => [
    key, typeof value === 'string' ? pseudoText(value) : pseudoResources(value),
  ]));
}
