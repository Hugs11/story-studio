import { translateHome as t } from '../i18n/homePresentation.js';
// Nommage local du .mbah : le titre courant gagne sur le nom acquis à l'import.
// Le titre avancé vient d'une lecture Rust ; ce module n'ouvre pas le payload.
function nameKey(value) {
  return String(value ?? '').trim().normalize('NFKC').toLowerCase();
}

export function isFallbackProjectName(value) {
  /* eslint-disable i18next/no-literal-string -- Noms provisoires historiques reconnus, pas des libellés affichés. */
  return ['', 'nouveau-projet', 'nouveau projet', 'mon-projet', 'mon projet',
    'projet', 'nouveau pack', 'projet sans titre', 'projet sans nom',
    'new-project', 'new project', 'my-project', 'my project', 'project', 'new audiobook', 'new pack', 'untitled project', 'unnamed project',
    'nuovo-progetto', 'nuovo progetto', 'mio-progetto', 'mio progetto', 'progetto', 'nuovo audiolibro', 'nuovo pack', 'progetto senza titolo', 'progetto senza nome'].includes(nameKey(value));
  /* eslint-enable i18next/no-literal-string */
}

function titleExcept(value, placeholder) {
  const title = String(value ?? '').trim();
  return placeholder.includes(nameKey(title)) ? '' : title;
}

export function suggestProjectName(project, { documentTitle = null, currentFileName = '' } = {}) {
  const advanced = project?.authoringMode === 'advanced';
  /* eslint-disable i18next/no-literal-string -- Comparaison multilingue des noms proposés ; aucune écriture. */
  const rootTitle = !advanced && project?.projectType === 'pack'
    ? titleExcept(project.rootName, ['menu racine', 'top menu', 'menu iniziale'])
    : '';
  const packTitle = titleExcept(advanced ? documentTitle : project?.packMetadata?.title, ['nouveau pack', 'new audiobook', 'new pack', 'nuovo audiolibro', 'nuovo pack']);
  /* eslint-enable i18next/no-literal-string */
  const localName = isFallbackProjectName(project?.projectName)
    ? ''
    : String(project.projectName).trim();
  return rootTitle || packTitle || localName || String(currentFileName).trim() || t('home:project.saveName.untitled');
}
