// Real browser checks for the project menus in all three editors and the catalogue.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorDialogProvider } from '../src/components/common/Dialog.jsx';
import { Toolbar } from '../src/components/layout/Toolbar.jsx';
import { CatalogueChrome } from '../src/components/Catalogue/CatalogueChrome.jsx';
import { buildToolbarInventory } from '../src/store/toolbarModel.js';
import { initializeI18n } from '../src/i18n/index.js';
import '../src/styles/variables.css';
import '../src/styles/layout.css';
import '../src/components/Catalogue/CatalogueScreen.css';
import '../src/components/Catalogue/CatalogueViews.css';
initializeI18n('fr');
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function run() {
  for (const editor of ['simple', 'pack', 'advanced', 'catalogue']) {
    const root = createRoot(document.getElementById('surface'));
    const inventory = buildToolbarInventory({ workspaceMode: editor === 'advanced' ? 'advanced' : 'hierarchical' });
    root.render(<ErrorDialogProvider>{editor === 'catalogue' ? <CatalogueChrome /> : <Toolbar inventory={inventory} />}</ErrorDialogProvider>);
    await frames();
    const trigger = document.querySelector(`[data-toolbar-id="${editor === 'catalogue' ? 'catalogue-menu' : 'project-menu'}"]`);
    assert(trigger, `${editor}: menu trigger exists`);
    trigger.parentElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    trigger.click(); await frames();
    const menu = document.querySelector('.project-menu');
    assert(menu && !menu.querySelector('.project-menu-head'), `${editor}: no redundant heading`);
    assert(menu.getAttribute('aria-label'), `${editor}: menu retains accessible label`);
    assert(menu.firstElementChild?.getAttribute('role') === 'menuitem', `${editor}: first element is an action`);
    assert(menu.querySelector('.project-menu-sep'), `${editor}: action groups remain separated`);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert(!document.querySelector('.tooltip-bubble'), `${editor}: trigger tooltip stays hidden while menu is open`);
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert(document.activeElement === menu.querySelector('[role="menuitem"]:not(:disabled)'), `${editor}: keyboard reaches first action`);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await frames();
    assert(!document.querySelector('.project-menu') && document.activeElement === trigger, `${editor}: Escape closes and restores focus`);
    root.unmount();
  }
  globalThis.dump('CATALOGUE_INTERACTION_OK\n');
}
run().catch(error => globalThis.dump(`CATALOGUE_INTERACTION_ERROR ${error.message} ${error.stack}\n`));
