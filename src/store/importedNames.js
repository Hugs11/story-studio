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
