/** D70: the saved project is the default, even when the selected pack is newer. */
export function editWarning(entry) {
  if (entry?.kind === 'project' || !entry?.existingProject) return null;
  const project = entry.existingProject;
  return { project, defaultAction: 'project', message: {
    key: 'catalogue:open.warning.message',
    params: { project: project.path, date: project.modifiedAt },
  } };
}
