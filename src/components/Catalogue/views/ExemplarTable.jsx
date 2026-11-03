import { MissingValue } from '../MissingValue.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { exemplarRow } from '../../../store/catalogue/detailsRow.js';
import { formatTags } from '../../../store/catalogue/formatTag.js';
import { domId } from '../../../store/catalogue/viewModes.js';
import { FormatTag } from '../FormatTag.jsx';

/**
 * Tableau des exemplaires d'une fiche (format, nom, dossier, version, date,
 * état), déplié sous une ligne ou affiché dans la fiche complète
 * (`full` : chemin complet et taille).
 */
export function ExemplarTable({ card, exemplars, full = false, idPrefix }) {
  const { t, cell } = useCatalogueTranslation();
  return <table className="catalogue-exemplar-table">
    <caption className={full ? undefined : 'catalogue-visually-hidden'}>{t('catalogue:exemplar.table.caption', { title: (card.displayTitle ?? card.title) ?? t('catalogue:card.untitled') })}</caption>
    <thead><tr>
      <th scope="col">{t('catalogue:exemplar.column.format')}</th>
      <th scope="col">{t('catalogue:exemplar.column.name')}</th>
      <th scope="col">{t(full ? 'catalogue:exemplar.column.path' : 'catalogue:exemplar.column.folder')}</th>
      <th scope="col">{t('catalogue:details.column.version')}</th>
      <th scope="col">{t('catalogue:details.column.modifiedAt')}</th>
      {full && <th scope="col">{t('catalogue:exemplar.column.size')}</th>}
      <th scope="col">{t('catalogue:exemplar.column.state')}</th>
    </tr></thead>
    <tbody>{exemplars.map((exemplar) => {
      const row = exemplarRow(exemplar);
      const triggerId = domId(`${idPrefix}-actions`, exemplar.id);
      return <tr key={exemplar.id} className={exemplar.available ? undefined : 'catalogue-exemplar--unavailable'}>
        <td><FormatTag tag={formatTags([exemplar])[0]} id={`${triggerId}-format`} /></td>
        <td>{row.name.kind === 'missing' ? <MissingValue /> : cell(row.name)}</td>
        <td className="catalogue-path">{full ? <>{row.path.kind === 'missing' ? <MissingValue /> : cell(row.path)}{row.member && <><br />{row.member.kind === 'missing' ? <MissingValue /> : cell(row.member)}</>}</> : row.folder.kind === 'missing' ? <MissingValue /> : cell(row.folder)}</td>
        <td>{row.version.kind === 'missing' ? <MissingValue /> : cell(row.version)}</td>
        <td>{row.modifiedAt.kind === 'missing' ? <MissingValue /> : cell(row.modifiedAt)}</td>
        {full && <td>{row.size.kind === 'missing' ? <MissingValue /> : cell(row.size)}</td>}
        <td>{row.state.kind === 'missing' ? <MissingValue /> : cell(row.state)}</td>
      </tr>;
    })}</tbody>
  </table>;
}
