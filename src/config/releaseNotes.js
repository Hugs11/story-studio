import i18next from 'i18next';

export const RELEASE_NOTES = Object.freeze({
  version: '0.9.11',
  date: '2026-11-08',
  highlights: [
    ['common:releaseNotes.current.queue.title', 'common:releaseNotes.current.queue.detail'],
    ['common:releaseNotes.current.sound.title', 'common:releaseNotes.current.sound.detail'],
    ['common:releaseNotes.current.updates.title', 'common:releaseNotes.current.updates.detail'],
    ['common:releaseNotes.current.episodes.title', 'common:releaseNotes.current.episodes.detail'],
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
