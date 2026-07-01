const IMPORT_CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/g;
const IMPORT_FILENAME_UNSAFE_REGEX = /[<>:"/\\|?*]/g;
const IMPORT_EMOJI_REGEX = /[\p{Extended_Pictographic}\u200d\ufe0f]/gu;
const IMPORT_TRAILING_PUNCTUATION_REGEX = /^[\s._-]+|[\s._-]+$/g;

export function sanitizeImportedName(value, fallback = '', options = {}) {
  const separatorPattern = options.preserveHyphens ? /_+/g : /[_-]+/g;
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(IMPORT_EMOJI_REGEX, ' ')
    .replace(IMPORT_CONTROL_CHARS_REGEX, ' ')
    .replace(IMPORT_FILENAME_UNSAFE_REGEX, ' ')
    .replace(separatorPattern, ' ')
    .replace(/\s+/g, ' ')
    .replace(IMPORT_TRAILING_PUNCTUATION_REGEX, '')
    .trim()
    .slice(0, 120)
    .trim();

  return normalized || fallback;
}

function importedNameKey(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

function importedEntryFallbackName(entry) {
  return entry?.type === 'menu'
    ? 'Collection importee'
    : entry?.type === 'zip'
      ? 'ZIP importe'
      : 'Histoire importee';
}

function collectImportedNameCounts(entries = [], counts = new Map()) {
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const sanitizedName = sanitizeImportedName(entry.name, importedEntryFallbackName(entry));
    const key = importedNameKey(sanitizedName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (entry.type === 'menu' && Array.isArray(entry.children)) {
      collectImportedNameCounts(entry.children, counts);
    }
  }
  return counts;
}

function makeUniqueImportedName(name, state) {
  const baseKey = importedNameKey(name);
  const baseDuplicateCount = state.originalNameCounts.get(baseKey) ?? 0;
  const nextCount = (state.countsByBaseName.get(baseKey) ?? 0) + 1;
  state.countsByBaseName.set(baseKey, nextCount);

  let count = nextCount;
  let candidate = baseDuplicateCount <= 1 || count === 1 ? name : `${name} ${count}`;
  let candidateKey = importedNameKey(candidate);
  while (
    state.usedNames.has(candidateKey)
    || (candidateKey !== baseKey && state.originalNameCounts.has(candidateKey))
  ) {
    count += 1;
    candidate = `${name} ${count}`;
    candidateKey = importedNameKey(candidate);
  }
  state.countsByBaseName.set(baseKey, count);
  state.usedNames.add(candidateKey);
  return candidate;
}

function sanitizeImportedEntriesWithState(entries = [], state) {
  return (entries ?? []).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const sanitizedName = sanitizeImportedName(entry.name, importedEntryFallbackName(entry));
    const nextEntry = {
      ...entry,
      name: makeUniqueImportedName(sanitizedName, state),
    };
    if (entry.type === 'menu' && Array.isArray(entry.children)) {
      nextEntry.children = sanitizeImportedEntriesWithState(entry.children, state);
    }
    return nextEntry;
  });
}

export function sanitizeImportedEntries(entries = []) {
  const state = {
    countsByBaseName: new Map(),
    originalNameCounts: collectImportedNameCounts(entries),
    usedNames: new Set(),
  };
  return sanitizeImportedEntriesWithState(entries, state);
}
