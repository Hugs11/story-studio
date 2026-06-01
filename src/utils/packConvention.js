// Convention supportee :
// - prefixe age : N+]
// - titre : espaces encodes en underscores
// - bonus optionnel : _(bonus)
// - auteur optionnel : [by_auteur
// - version optionnelle : _Vn dans le bloc auteur ou apres le titre
// - producteur optionnel : Producteur-Titre quand producteur et auteur sont differents

function toUnderscored(value) {
  return String(value || '').trim().replace(/\s+/g, '_');
}

function toIntVersion(value) {
  const number = Number.parseInt(String(value ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function looksLikeProducerCandidate(value) {
  const parts = String(value || '').split('_').filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => /^[A-Za-zÀ-ž][A-Za-zÀ-ž0-9]*$/.test(part));
}

export function parseConventionName(raw) {
  if (!raw) return null;
  const ageMatch = String(raw).match(/^(\d+)\+\]/);
  if (!ageMatch) return null;
  const minAge = ageMatch[1];
  let rest = String(raw).slice(ageMatch[0].length);

  let author = '';
  let version = 1;
  const byIdx = rest.indexOf('[by_');
  if (byIdx !== -1) {
    const byPart = rest.slice(byIdx + 4);
    const vMatch = byPart.match(/[_-][Vv](\d+)$/);
    if (vMatch) {
      version = toIntVersion(vMatch[1]);
      author = byPart.slice(0, byPart.length - vMatch[0].length).replace(/_/g, ' ').trim();
    } else {
      author = byPart.replace(/_/g, ' ').trim();
    }
    rest = rest.slice(0, byIdx);
  } else {
    const standaloneV = rest.match(/_[Vv](\d+)$/);
    if (standaloneV) {
      version = toIntVersion(standaloneV[1]);
      rest = rest.slice(0, rest.length - standaloneV[0].length);
    }
  }

  let producer = '';
  let core = rest;
  const prodSep = rest.indexOf('_-_');
  if (prodSep !== -1) {
    producer = rest.slice(0, prodSep).replace(/_/g, ' ').trim();
    core = rest.slice(prodSep + 3);
  } else {
    const firstDash = rest.indexOf('-');
    if (firstDash > 0) {
      const candidate = rest.slice(0, firstDash);
      if (looksLikeProducerCandidate(candidate)) {
        producer = candidate.replace(/_/g, ' ').trim();
        core = rest.slice(firstDash + 1);
      }
    }
  }

  let bonus = '';
  let title = core;
  const bonusParen = core.match(/_\((.+)\)$/);
  if (bonusParen) {
    bonus = bonusParen[1].replace(/_/g, ' ').trim();
    title = core.slice(0, core.length - bonusParen[0].length);
  } else {
    const lastDash = core.lastIndexOf('-');
    if (lastDash !== -1) {
      const potBonus = core.slice(lastDash + 1).replace(/_/g, ' ').trim();
      if (potBonus && /^\d/.test(potBonus)) {
        bonus = potBonus;
        title = core.slice(0, lastDash);
      }
    }
  }

  return {
    title: title.replace(/_/g, ' ').trim(),
    author,
    version,
    minAge,
    producer,
    bonus,
    description: '',
    namingMode: 'convention',
    legacyExportName: '',
    legacyName: '',
  };
}

export function generateConventionName(metadata = {}) {
  const title = toUnderscored(metadata.title);
  if (!title) return '';

  const bonus = toUnderscored(metadata.bonus);
  const author = toUnderscored(metadata.author);
  const producer = toUnderscored(metadata.producer);
  const rawProducer = String(metadata.producer || '').trim();
  const rawAuthor = String(metadata.author || '').trim();
  const minAge = String(metadata.minAge || metadata.age || '3').replace(/\D/g, '') || '3';
  const version = toIntVersion(metadata.version);
  const bonusPart = bonus ? `_(${bonus})` : '';
  const prefix = `${minAge}+]`;
  const titlePart = producer && (!author || rawProducer !== rawAuthor)
    ? `${producer}-${title}${bonusPart}`
    : `${title}${bonusPart}`;
  const versionSuffix = version > 1 ? `_V${version}` : '';

  if (!author) return `${prefix}${titlePart}${versionSuffix}`;
  return `${prefix}${titlePart}[by_${author}${versionSuffix}`;
}

export function getExportPackName(metadata = {}) {
  const legacy = String(metadata.legacyExportName || '').trim();
  if (metadata.namingMode === 'legacy' && legacy) return legacy;
  return generateConventionName(metadata) || legacy || String(metadata.title || '').trim() || 'Story Studio';
}
