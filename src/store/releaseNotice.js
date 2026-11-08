import { KEYS, read, write } from './persistentSettings.js';

const listeners = new Set();
export const RELEASE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
let inFlight = null;
let lastAttempt = 0;
let generation = 0;
let announcedInSession = null;
let consentInSession;

// null means that the question has never been answered, including older installs.
export function readReleaseConsent() {
  if (consentInSession !== undefined) return consentInSession;
  const value = read(KEYS.RELEASE_CHECK_ENABLED);
  return value === 'true' ? true : value === 'false' ? false : null;
}
export function subscribeReleaseConsent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function writeReleaseConsent(enabled) {
  consentInSession = enabled === true;
  generation += 1;
  write(KEYS.RELEASE_CHECK_ENABLED, String(consentInSession));
  for (const listener of listeners) listener();
}
export function shouldAskReleaseConsent(consent, dialogOpen) {
  return consent === null && !dialogOpen;
}
export function releaseCheckDue(enabled, previous, now) {
  return enabled === true && (!Number.isFinite(previous) || previous <= 0 || previous > now || now - previous >= RELEASE_CHECK_INTERVAL);
}
export function allowedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.startsWith('https://github.com/Hugs11/story-studio/releases/')
      && url.pathname.startsWith('/Hugs11/story-studio/releases/') && url.hostname === 'github.com' && !url.username && !url.password && !url.port;
  } catch { return false; }
}

// Timestamp the attempt, including offline/HTTP failures, before invoking Rust.
// Shared promise also protects React StrictMode and repeated consumers.
export function checkReleaseOnce(invoke, now = Date.now()) {
  if (readReleaseConsent() !== true) return Promise.resolve(null);
  if (inFlight) return inFlight;
  const previous = Math.max(lastAttempt, Number(read(KEYS.RELEASE_CHECK_AT)) || 0);
  if (!releaseCheckDue(true, previous, now)) return Promise.resolve(null);
  lastAttempt = now;
  write(KEYS.RELEASE_CHECK_AT, String(now));
  const ticket = generation;
  inFlight = Promise.resolve().then(() => {
    if (ticket !== generation || readReleaseConsent() !== true) return null;
    return invoke('check_stable_release', { enabled: true });
  }).catch(() => null).then(result => (
    ticket === generation && readReleaseConsent() === true && result
      && /^\d+\.\d+\.\d+$/.test(result.version) && allowedReleaseUrl(result.url) ? result : null
  )).finally(() => { inFlight = null; });
  return inFlight;
}
export function claimReleaseNotice(release) {
  if (!release || readReleaseConsent() !== true || !allowedReleaseUrl(release.url)) return false;
  if (read(KEYS.RELEASE_ANNOUNCED) === release.version || announcedInSession === release.version) return false;
  announcedInSession = release.version;
  write(KEYS.RELEASE_ANNOUNCED, release.version);
  return true;
}
