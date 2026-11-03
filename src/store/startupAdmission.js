import { invoke, isTauri } from '@tauri-apps/api/core';
import { initializeI18n } from '../i18n/index.js';
import { loadLanguage } from '../i18n/language.js';
import { showAlreadyOpen } from '../hooks/useFileDialog.js';

export async function admitEditorStartup({ native = isTauri(), call = invoke,
  show = showAlreadyOpen, language = loadLanguage, initialize = initializeI18n } = {}) {
  if (!native || !await call('startup_blocked')) return true;
  initialize(language(undefined, { persist: false }));
  try { await show(); }
  finally { await call('exit_secondary_instance'); }
  return false;
}
