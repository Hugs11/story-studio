import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
function reason(t, value) {
  switch (value) {
    case 'missingIdentity': return t('catalogue:backupImport.missingIdentity');
    case 'identityNotFound': return t('catalogue:backupImport.identityNotFound');
    case 'ambiguousIdentity': return t('catalogue:backupImport.ambiguousIdentity');
    case 'referenceUnavailable': return t('catalogue:backupImport.referenceUnavailable');
    default: return '';
  }
}
export function UnresolvedAssociations({ items, associations, dispatch, candidates = [] }) {
  const { t } = useCatalogueTranslation();
  return <section aria-label={t('catalogue:backupImport.unresolved')}>
    <h3>{t('catalogue:backupImport.unresolved')}</h3><p>{t('catalogue:backupImport.associationHelp')}</p>
    <datalist id="catalogue-import-cards">{candidates.map(card => <option key={card.id} value={card.id} label={(card.displayTitle ?? card.title) || card.id} />)}</datalist>
    <ul>{items.map(item => <li key={item.id}>
      <p>{item.label || t('catalogue:card.untitled')} — {reason(t, item.reason)} {item.identity}</p>
      {item.reason !== 'referenceUnavailable' && <label>{t('catalogue:backupImport.associate')}<input list="catalogue-import-cards" value={associations[item.id] ?? ''} onChange={e => dispatch({ type: 'associate', id: item.id, target: e.target.value })} /></label>}
    </li>)}</ul>
  </section>;
}
