import { useEffect, useState } from 'react';
import i18next from 'i18next';

// Keep IPC envelopes in state and resolve them again when the UI language changes.
export function useMessageLanguage() {
  const [, setLanguage] = useState(i18next.resolvedLanguage);
  useEffect(() => {
    const update = (language) => setLanguage(language);
    i18next.on('languageChanged', update);
    return () => i18next.off('languageChanged', update);
  }, []);
}
