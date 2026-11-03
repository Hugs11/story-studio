import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { exemplarRow } from '../../../store/catalogue/detailsRow.js';
import { CatalogueMenuItem, CatalogueMenuPanel } from './CatalogueMenu.jsx';
import { MenuSubmenu } from '../../layout/MenuSubmenu.jsx';
import { TagMenuEntries } from '../tags/TagSubmenu.jsx';
import { Copy, FolderOpen, Layers, Play, Send, ShieldCheck, SquarePen, Star, Tag, Trash2, X } from '../../icons/LucideLocal.jsx';

// Même icône que la même action ailleurs dans l'app (cartes, fiche, panneau de sélection, vérificateur).
const ACTION_ICONS = Object.freeze({
  simulate: Play, edit: SquarePen, openProject: SquarePen, editPack: SquarePen, openAndGenerate: SquarePen,
  reveal: FolderOpen, favorite: Star, tags: Tag, copyUuid: Copy, copyTitle: Copy,
  removeFromCatalogue: X, trash: Trash2, checkPack: ShieldCheck, assemble: Layers, luniiSend: Send,
});

const CHOICE_TITLES = Object.freeze({
  reveal: 'catalogue:menu.choose.reveal',
});

/**
 * Menu contextuel d'une carte : actions de fiche, puis, pour une action
 * d'exemplaire avec plusieurs cibles, le choix explicite de l'exemplaire
 * (jamais « le plus récent » implicitement).
 * Favori et étiquettes visent la fiche entière. Les actions
 * d’exemplaire restent dans leur composition séparée. Les étiquettes s'ouvrent
 * en cascade à droite du menu (`tagMenu` : étiquettes, cibles, mutation).
 */
export function CardContextMenu({ menu, card, entries, dispatch, onActivate, onBack, tagMenu }) {
  const { t, cell } = useCatalogueTranslation();
  const title = (card.displayTitle ?? card.title) ?? t('catalogue:card.untitled');
  const label = menu.step ? t(CHOICE_TITLES[menu.step.action] ?? 'catalogue:menu.card.label', { title }) : t('catalogue:menu.card.label', { title });
  const decorated = entries.map((entry) => {
    if (entry.action.id === 'tags') return { ...entry, label: t('catalogue:tags.contextMenu'), submenu: true };
    if (!menu.step || entry.back || !entry.exemplar) return entry;
    const row = exemplarRow(entry.exemplar);
    return {
      ...entry,
      label: [t(row.formatKey), cell(row.name)].join(' — '),
      detail: [cell(row.folder), cell(row.version), cell(row.modifiedAt), cell(row.state)].join(' · '),
    };
  });
  return <CatalogueMenuPanel menu={menu} label={label} entries={decorated} dispatch={dispatch} onActivate={onActivate} onBack={onBack}>
    {(itemProps) => <>
      {menu.step && <div className="catalogue-menu-group-header" aria-hidden="true">{label}</div>}
      {decorated.flatMap((entry, index) => [
        ['edit', 'copyUuid', 'removeFromCatalogue'].includes(entry.action.id) && <div key={`${entry.key}-separator`} role="separator" className="project-menu-sep" />,
        entry.action.id === 'tags' && tagMenu && !menu.step
          ? <MenuSubmenu key={entry.key} label={entry.label} trigger={cascade => <CatalogueMenuItem entry={entry} Icon={ACTION_ICONS.tags} cascade={cascade} {...itemProps(index)} />}><TagMenuEntries {...tagMenu} /></MenuSubmenu>
          : <CatalogueMenuItem key={entry.key} entry={entry} Icon={menu.step || entry.back ? undefined : ACTION_ICONS[entry.action.id]} {...itemProps(index)} />,
      ])}
    </>}
  </CatalogueMenuPanel>;
}
