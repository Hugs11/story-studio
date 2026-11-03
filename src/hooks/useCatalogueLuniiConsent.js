import { useEffect, useRef } from 'react';
import { useErrorDialog } from '../components/common/Dialog.jsx';
import { useCatalogueTranslation } from '../i18n/useCatalogueTranslation.js';
import { askLuniiPermission } from '../store/catalogue/luniiConsent.js';

export function useCatalogueLuniiConsent(api, onError) {
  const { showChoiceDialog } = useErrorDialog();
  const { t } = useCatalogueTranslation();
  const initial = useRef({ api, onError, showChoiceDialog, t });
  useEffect(() => {
    let active = true;
    const { api, onError, showChoiceDialog, t } = initial.current;
    // Defer until after the mount probe so StrictMode opens a single question.
    queueMicrotask(() => {
      if (!active || !api.luniiPermission) return;
      void askLuniiPermission(api, () => showChoiceDialog({
        title: t('catalogue:lunii.permission.title'),
        message: t('catalogue:lunii.permission.question'),
        actions: [
          { value: true, label: t('catalogue:lunii.permission.yes'), kind: 'primary' },
          { value: false, label: t('catalogue:lunii.permission.no'), autoFocus: true },
        ],
      }), () => active).catch(error => { if (active) onError(error); });
    });
    return () => { active = false; };
  }, []);
}
