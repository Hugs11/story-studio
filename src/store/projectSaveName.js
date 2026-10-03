// Nommage local du .mbah : le titre courant gagne sur le nom acquis à l'import.
// Le titre avancé vient d'une lecture Rust ; ce module n'ouvre pas le payload.
function nameKey(value) {
  return String(value ?? '').trim().normalize('NFKC').toLowerCase();
}

export function isFallbackProjectName(value) {
  return ['', 'nouveau-projet', 'nouveau projet', 'mon-projet', 'mon projet',
    'projet', 'nouveau pack', 'projet sans titre', 'projet sans nom'].includes(nameKey(value));
}

function titleExcept(value, placeholder) {
  const title = String(value ?? '').trim();
  return nameKey(title) === placeholder ? '' : title;
}

export function suggestProjectName(project, { documentTitle = null, currentFileName = '' } = {}) {
  const advanced = project?.authoringMode === 'advanced';
  const rootTitle = !advanced && project?.projectType === 'pack'
    ? titleExcept(project.rootName, 'menu racine')
    : '';
  const packTitle = titleExcept(advanced ? documentTitle : project?.packMetadata?.title, 'nouveau pack');
  const localName = isFallbackProjectName(project?.projectName)
    ? ''
    : String(project.projectName).trim();
  return rootTitle || packTitle || localName || String(currentFileName).trim() || 'Projet sans titre';
}
