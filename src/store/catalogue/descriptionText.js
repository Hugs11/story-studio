const ENTITIES = Object.freeze({
  nbsp: '\u00a0', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È', ecirc: 'ê', euml: 'ë',
  agrave: 'à', Agrave: 'À', acirc: 'â', auml: 'ä', ccedil: 'ç', Ccedil: 'Ç',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  oelig: 'œ', OElig: 'Œ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  euro: '€', acute: '´', deg: '°', bull: '•', middot: '·',
  aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ograve: 'ò', igrave: 'ì',
});

/** Pure, single-pass decoding; unknown or invalid entities remain literal. */
export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu, (entity, name) => {
    if (!name.startsWith('#')) return ENTITIES[name] ?? entity;
    const hex = name[1].toLowerCase() === 'x';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : entity;
  });
}

/** Imported descriptions are plain text: preserve breaks, discard all other markup. */
export function descriptionText(value) {
  return decodeHtmlEntities(String(value ?? '').replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]*>/gu, '').replace(/<[^>]*$/gu, '')).trim();
}
