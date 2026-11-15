import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { presentCommon, useCommonTranslation } from '../../i18n/commonPresentation.js';
import { FilePen, House, Package, Save, Waypoints } from '../icons/LucideLocal';
import { MenuItem, MenuPopover } from './MenuPopover';

// Une entrée du menu, pilotée par l'inventaire de la barre : libellé,
// raccourci et disponibilité viennent de la même source que le clavier. Une
// commande tenue par un export reste **listée** et dit pourquoi, au lieu de
// disparaître du menu.
function ProjectMenuItem({ entry, fallbackLabel, fallbackShortcut, Icon, onClick }) {
  useCommonTranslation();
  const label = entry?.label ?? fallbackLabel;
  const available = entry ? entry.available : true;
  return (
    <MenuItem
      toolbarId={entry?.id}
      Icon={Icon}
      label={label}
      detail={available ? (entry?.shortcut ?? fallbackShortcut) : presentCommon(entry.unavailableReason)}
      disabled={!available}
      title={available ? undefined : presentCommon(entry.unavailableReason)}
      onClick={onClick}
    />
  );
}

export function ProjectMenuPopover({
  open,
  onOpenChange,
  trigger,
  shortcutLabels,
  // Le groupe « fichier » conserve aussi les commandes d'ouverture au clavier.
  commands = [],
  onNewProject,
  onReturnToCatalogue,
  onSaveProject,
  onSaveProjectAs,
  onContinueInGraph,
}) {
  const { t } = useCommonTranslation();
  const { t: catalogueT } = useCatalogueTranslation();
  const find = (id) => commands.find((entry) => entry.id === id) ?? null;
  function handleAction(action) {
    onOpenChange?.(false);
    action?.();
  }

  return (
    <MenuPopover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      label={t('common:project.menu.title')}
    >
      <ProjectMenuItem entry={find('returnToCatalogue')} fallbackLabel={catalogueT('catalogue:open.return.label')} fallbackShortcut={shortcutLabels.returnToCatalogue} Icon={Package} onClick={() => handleAction(onReturnToCatalogue)} />
      <ProjectMenuItem
        entry={find('newProject')}
        fallbackLabel={t('common:project.home.label')}
        fallbackShortcut={shortcutLabels.newProject}
        Icon={House}
        onClick={() => handleAction(onNewProject)}
      />
      <span className="project-menu-sep" />
      <ProjectMenuItem
        entry={find('saveProject')}
        fallbackLabel={t('common:project.save.label')}
        fallbackShortcut={shortcutLabels.saveProject}
        Icon={Save}
        onClick={() => handleAction(onSaveProject)}
      />
      <ProjectMenuItem
        entry={find('saveProjectAs')}
        fallbackLabel={t('common:project.saveAs.fallbackLabel')}
        fallbackShortcut={shortcutLabels.saveAs}
        Icon={FilePen}
        onClick={() => handleAction(onSaveProjectAs)}
      />
      {find('continueInGraph') ? (
        <>
          <span className="project-menu-sep" />
          <ProjectMenuItem
            entry={find('continueInGraph')}
            fallbackLabel={t('common:project.continueInGraph.label')}
            Icon={Waypoints}
            onClick={() => handleAction(onContinueInGraph)}
          />
        </>
      ) : null}
    </MenuPopover>
  );
}
