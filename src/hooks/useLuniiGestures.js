import { useState } from 'react';
import { useErrorDialog } from '../components/common/Dialog.jsx';
import { useCatalogueTranslation } from '../i18n/useCatalogueTranslation.js';
import { createLuniiGestures, luniiConfirmation } from '../store/catalogue/luniiGestures.js';

export function useLuniiGestures(lunii) {
  const { t } = useCatalogueTranslation();
  const { showChoiceDialog } = useErrorDialog();
  const [announcement, setAnnouncement] = useState('');
  const confirm = (title, message, label, kind) => showChoiceDialog(luniiConfirmation(t, title, message, label, kind));
  const choose = dialog => showChoiceDialog({ variant: 'lunii', ...dialog });
  return { announcement, ...createLuniiGestures(lunii, t, confirm, setAnnouncement, choose) };
}

