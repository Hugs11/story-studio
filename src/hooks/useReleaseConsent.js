import { useSyncExternalStore } from 'react';
import { readReleaseConsent, subscribeReleaseConsent } from '../store/releaseNotice.js';

export function useReleaseConsent() {
  return useSyncExternalStore(subscribeReleaseConsent, readReleaseConsent, readReleaseConsent);
}
