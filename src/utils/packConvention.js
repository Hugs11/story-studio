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
  const value = String(raw).trim().replace(/\.(zip|7z)$/i, '');
  const ageMatch = value.match(/^(\d+)\+\]/);
  if (!ageMatch) return null;
  const minAge = ageMatch[1];
  let rest = value.slice(ageMatch[0].length);

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

/**
 * Sépare un préfixe d'âge « N+ » en tête d'un titre (« 3+ Example »,
 * « 6+]Titre »). Sans séparateur — « 3+5 », « 3+Titre » —, ce n'est pas un
 * préfixe d'âge. Rend `null` quand le titre n'en porte pas.
 */
export function splitLeadingAge(name) {
  const match = String(name || '').match(/^\s*(\d{1,2})\s*\+(?:\]|\s)\s*(\S.*)$/);
  return match && match[2].trim() ? { minAge: match[1], title: match[2].trim() } : null;
}

export function generateConventionName(metadata = {}) {
  // Un titre qui porte déjà la convention complète (« 3+]Titre[by_Auteur_V5 »,
  // repris tel quel d'un pack produit) n'est composé qu'une fois : on repart de
  // ses champs, sans empiler l'âge, l'auteur ni la version. Les champs saisis
  // l'emportent ; la version est toujours celle demandée.
  const parsed = parseConventionName(metadata.title);
  if (parsed) {
    return generateConventionName({
      ...metadata,
      title: parsed.title,
      minAge: metadata.minAge || metadata.age || parsed.minAge,
      author: metadata.author || parsed.author,
      producer: metadata.producer || parsed.producer,
      bonus: metadata.bonus || parsed.bonus,
    });
  }
  // Le préfixe `N+]` porte déjà l'âge : un titre qui le répète (« 3+ Example »,
  // tel qu'un pack FS le reçoit de son nom de fichier) ne le double pas.
  const leading = splitLeadingAge(metadata.title);
  const title = toUnderscored(leading?.title ?? metadata.title);
  if (!title) return '';

  const bonus = toUnderscored(metadata.bonus);
  const author = toUnderscored(metadata.author);
  const producer = toUnderscored(metadata.producer);
  const rawProducer = String(metadata.producer || '').trim();
  const rawAuthor = String(metadata.author || '').trim();
  // Sans âge saisi, celui que le titre porte en tête (« 5+ Le prince… ») :
  // retomber sur 3 renommait « 3+] » un pack importé de 5 ans.
  const minAge = String(metadata.minAge || metadata.age || leading?.minAge || '3').replace(/\D/g, '') || '3';
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

/**
 * Version suivante suggérée pour un pack : incrémente
 * la version courante d'une unité. Sans version (ou version invalide), suggère 2
 * → suffixe `_V2`. L'utilisateur reste libre de la changer.
 */
export function bumpPackVersion(version) {
  return toIntVersion(version) + 1;
}

export function getExportPackName(metadata = {}) {
  const legacy = String(metadata.legacyExportName || '').trim();
  if (metadata.namingMode === 'legacy') return legacy || String(metadata.title || '').trim() || 'Story Studio';
  return generateConventionName(metadata) || legacy || String(metadata.title || '').trim() || 'Story Studio';
}
