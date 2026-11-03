import i18next from 'i18next';

export const RELEASE_NOTES = Object.freeze({
  version: '0.9.10',
  date: '2026-11-02',
  highlights: [
    ['common:releaseNotes.current.languages.title', 'common:releaseNotes.current.languages.detail'],
    ['common:releaseNotes.current.catalogue.title', 'common:releaseNotes.current.catalogue.detail'],
    ['common:releaseNotes.current.missing.title', 'common:releaseNotes.current.missing.detail'],
  ],
  fixes: [
    ['common:releaseNotes.current.fixes.label'],
  ],
  chores: [],
  discordUrl: 'https://discord.gg/jeC6Qk4NS',
  changelogUrl: 'https://github.com/Hugs11/story-studio/blob/main/CHANGELOG.md',
});

export function shouldShowReleaseNotes(appVersion, seenVersion, language = i18next.resolvedLanguage ?? i18next.language ?? 'fr') {
  // Les notes traduites commencent à la 0.9.10 ; conserver les notes FR historiques.
  const [major, minor, patch] = RELEASE_NOTES.version.split('-')[0].split('.').map(Number);
  const predatesTranslations = major === 0 && (minor < 9 || (minor === 9 && patch < 10));
  if (predatesTranslations && !['fr', 'pseudo'].includes(language.split('-')[0])) return false;
  return appVersion === RELEASE_NOTES.version && seenVersion !== appVersion;
}
