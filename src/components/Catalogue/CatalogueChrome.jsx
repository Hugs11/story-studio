import { useLayoutEffect, useRef, useState } from 'react';
import { Copy, Folder, House, Package } from '../icons/LucideLocal.jsx';
import { ToolbarButton, ToolbarIcon } from '../layout/Toolbar.jsx';
import { MenuItem, MenuPopover } from '../layout/MenuPopover.jsx';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { useCommonTranslation } from '../../i18n/commonPresentation.js';
import { LuniiStatusPill } from './lunii/LuniiStatusPill.jsx';
import { CatalogueActivity } from './activity/CatalogueActivity.jsx';
import '../layout/Toolbar.css';

export const CATALOGUE_MENU_ID = 'catalogue-menu';

export function measureCatalogueToolbar(element) {
  element.classList.remove('is-compact');
  element.classList.add('is-measuring');
  const required = element.scrollWidth;
  element.classList.remove('is-measuring');
  element.classList.toggle('is-compact', required > element.clientWidth);
}

export function CatalogueChrome({ activity, searchControls, viewControls, activeFilters, lunii, onHome, onPreferences, onDuplicates }) {
  const { t } = useCatalogueTranslation();
  const { t: commonT } = useCommonTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const toolbar = useRef(null);
  // Mesure réelle des contrôles dépliés, traductions et pastilles comprises.
  // La recherche conserve 180 px ; aucun seuil de viewport supposé.
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => measureCatalogueToolbar(element);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    let disposed = false;
    document.fonts?.ready.then(() => { if (!disposed) measure(); });
    measure();
    return () => { disposed = true; observer.disconnect(); };
  }, [searchControls, viewControls, lunii, activity]);
  const act = (callback) => { setMenuOpen(false); callback?.(); };
  return (
    <div ref={toolbar} className="chrome-toolbar catalogue-chrome">
      <div className="chrome-toolbar-left">
        <MenuPopover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label={t('catalogue:header.menu')}
          trigger={({ openPopover }) => (
            <ToolbarButton
              id={CATALOGUE_MENU_ID}
              title={t('catalogue:header.menu')}
              label={t('catalogue:screen.title.label')}
              onClick={openPopover}
              active={menuOpen}
              tooltipDisabled={menuOpen}
              trailing={<span className="chrome-project-caret" aria-hidden="true">▾</span>}
            >
              <ToolbarIcon Icon={Package} />
            </ToolbarButton>
          )}
        >
          <MenuItem Icon={House} label={commonT('common:project.home.label')} onClick={() => act(onHome)} />
          <span className="project-menu-sep" />
          <MenuItem Icon={Folder} label={t('catalogue:header.folders')} onClick={() => act(onPreferences)} />
          <MenuItem Icon={Copy} label={t('catalogue:header.duplicates')} onClick={() => act(onDuplicates)} />
        </MenuPopover>
        <LuniiStatusPill lunii={lunii} />
      </div>

      <div className="chrome-toolbar-center">{searchControls}</div>
      <div className="chrome-toolbar-right">
        {viewControls}
        <CatalogueActivity {...activity} />
      </div>
      {activeFilters}
    </div>
  );
}
