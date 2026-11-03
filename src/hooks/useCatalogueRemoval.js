import { useCallback, useRef } from 'react';
import { useErrorDialog } from '../components/common/Dialog.jsx';
import { useCatalogueTranslation } from '../i18n/useCatalogueTranslation.js';
import { catalogueDataApi } from '../store/catalogue/catalogueDataApi.js';

/**
 * « Retirer du catalogue » pour des packs hors ligne : aperçu des fiches
 * concernées, confirmation explicite, puis retrait (favoris, corrections et
 * étiquettes effacés avec elles ; aucun fichier de pack touché). Seul un geste
 * confirmé efface : l'application ne déduit jamais une suppression.
 */
export function useCatalogueRemoval({ onRemoved, onAnnounce, onError, api = catalogueDataApi }) {
  const { t } = useCatalogueTranslation();
  const { showChoiceDialog } = useErrorDialog();
  const running = useRef(false);
  return useCallback(async (cards) => {
    const ids = cards.map((card) => card.id);
    if (!ids.length || running.current) return false;
    running.current = true;
    try {
      const preview = await api.previewRemoveCards(ids);
      const confirmed = await showChoiceDialog({
        title: t('catalogue:actions.removeFromCatalogue.label'),
        message: t('catalogue:sources.remove.confirm', { count: preview.count }),
        actions: [
          { value: false, label: t('catalogue:sources.remove.cancel'), autoFocus: true },
          { value: true, label: t('catalogue:sources.remove.accept'), kind: 'danger' },
        ],
      });
      if (confirmed !== true) return false;
      await api.removeCards(preview.ficheIds, preview.catalogueRevision);
      onAnnounce?.({ key: 'catalogue:actions.removeFromCatalogue.done', params: { count: preview.count } });
      await onRemoved?.();
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    } finally { running.current = false; }
  }, [api, onAnnounce, onError, onRemoved, showChoiceDialog, t]);
}
