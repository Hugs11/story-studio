import { exemplarRow, storiesCell, durationCell } from '../../../store/catalogue/detailsRow.js';
import { baseName, parentPath } from '../../../store/catalogue/formatTag.js';
import { damagedLine } from '../../../store/catalogue/damagedMedia.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { FormatTag } from '../FormatTag.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

const segments = values => values.map((value, index) => <span key={index}>{index > 0 && ' · '}<span className="catalogue-compact-exemplar-segment">{value}</span></span>);

/** Same two-line file identity in the fiche and every exemplar picker. */
export function CompactExemplar({ exemplar, showState = false, latest = false, identicalCopy = false, showName = false }) {
  const { t, cell, line } = useCatalogueTranslation();
  const damage = damagedLine(exemplar);
  const row = exemplarRow(exemplar);
  const folder = parentPath(exemplar.namedPath ?? (exemplar.member ? exemplar.containerPath ?? exemplar.path : exemplar.path));
  const values = [row.modifiedAt, row.size].filter(value => value.kind !== 'missing').map(cell);
  const figures = [storiesCell(exemplar.storyCount), durationCell(exemplar.durationSeconds)].filter(value => value.kind !== 'missing').map(cell);
  if (identicalCopy) figures.push(t('catalogue:exemplar.identicalCopy'));
  return <span className="catalogue-compact-exemplar">
    <span className="catalogue-compact-exemplar-heading"><FormatTag tag={{ format: exemplar.format, labelKey: row.formatKey, mentions: [], allUnavailable: !exemplar.available }} compact />
      {showName && <span className="catalogue-fiche-copy-name">{cell(row.name)}</span>}
      {row.version.kind !== 'missing' && <span>{cell(row.version)}</span>}
      {latest && <small>{t('catalogue:open.choice.latest')}</small>}
    </span>
    {damage && <span className="catalogue-compact-exemplar-damaged"><span aria-hidden="true"><b>!</b> </span>{line(damage)}</span>}
    {!showName && figures.length > 0 && <span className="catalogue-compact-exemplar-figures">{segments(figures)}</span>}
    <span className="catalogue-compact-exemplar-detail">{segments(values)}{folder && <>{values.length > 0 && ' · '}<Tooltip text={folder} asChild wrap><span className="catalogue-fiche-copy-folder">{baseName(folder) ?? folder}</span></Tooltip></>}
      {showName && figures.length > 0 && <>{values.length > 0 || folder ? ' · ' : ''}{segments(figures)}</>}
      {showState && !exemplar.available && <> · <span className="catalogue-compact-exemplar-segment">{cell(row.state)}</span></>}
    </span>
  </span>;
}
