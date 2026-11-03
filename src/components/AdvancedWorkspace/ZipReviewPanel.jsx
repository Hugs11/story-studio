// La relecture d'une archive exportée, dans l'espace de travail avancé.
//
// C'est **le simulateur du dépôt**, pas une seconde implémentation : le même
// `FlatSimulator`, le même transport `load_pack_zip` / `get_pack_asset`, le même
// lecteur audio partagé. Il est monté **sans projet hiérarchique** — lui en
// fabriquer un vide pour satisfaire une signature monterait un arbre qui
// n'existe pas dans un document avancé.
//
// Il a un frère, `DocumentSimulationPanel`, qui joue le document en
// cours au lieu de l'archive produite. Les deux ne se remplacent pas : celui-ci
// prouve ce qui a **réellement** été produit, ce que l'écoute du document ne
// prouve pas. Ils sont mutuellement exclusifs à l'écran, pas dans l'usage.
//
// Le bandeau dit ce que la simulation est vraiment : l'archive produite, à la
// révision qui l'a produite. Après une nouvelle édition, il cesse de la
// présenter comme celle du document courant — c'est la seule chose qui empêche
// de croire qu'on vient d'écouter sa dernière modification.

import { FloatingSimulator } from '../FloatingSimulator/FloatingSimulator';
import { Button } from '../common/Button';
import { EDITOR_LAYOUT_SCOPE } from '../../store/persistentSettings.js';
import { useCheckerTranslation } from '../../i18n/useCheckerTranslation.js';

export function ZipReviewPanel({ review, onClose }) {
  const { t } = useCheckerTranslation();
  if (!review) return null;
  return (
    <>
      <div
        className="advanced-review-banner"
        role="status"
        data-current={review.isCurrentRevision ? 'true' : 'false'}
      >
        <span className="advanced-review-banner__title">
          {t('checker:review.banner.title')}
        </span>
        <code className="advanced-review-banner__path">{review.zipPath}</code>
        <span className="advanced-review-banner__state">
          {review.isCurrentRevision
            ? t('checker:review.banner.current')
            : t('checker:review.banner.stale')}
        </span>
        <Button size="sm" onClick={onClose}>{t('checker:review.close.action')}</Button>
      </div>
      <FloatingSimulator
        zipPath={review.zipPath}
        hostSelector=".workspace"
        layoutScope={EDITOR_LAYOUT_SCOPE.ADVANCED}
        onClose={onClose}
      />
    </>
  );
}
