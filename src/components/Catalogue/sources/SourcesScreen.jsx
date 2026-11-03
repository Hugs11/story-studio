import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { AddSourceControl } from './AddSourceControl.jsx';
import { SourceRow } from './SourceRow.jsx';
import { SourceProposals } from './SourceProposals.jsx';
export function SourcesScreen({ sources, onAdd, onRefresh }) {
  const { t } = useCatalogueTranslation();
  return <section aria-label={t('catalogue:screen.sources.label')}>
    <ul className="opts-catalogue-source-list">{sources.items.filter((s) => s.status === 'active').map((source) => <SourceRow key={source.id} source={source} sources={sources.items} busy={sources.busy} onRemove={sources.remove} onRefresh={onRefresh} />)}</ul>
    <AddSourceControl sources={sources.items} busy={sources.busy || sources.loading} onAdd={onAdd} />
    <SourceProposals items={sources.items.filter((s) => s.status === 'hint')} busy={sources.busy} onResolve={onAdd} />
  </section>;
}
