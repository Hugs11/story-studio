import { useMemo } from 'react';
import { buildProjectIndex, buildSelectedNode, collectAllMenus } from '../store/projectModel';
import { getProjectValidationIssues } from '../store/projectValidation';

export function useProjectDerivedData(project, {
  selectedId = 'root',
  fileAudit = {},
  projectIndex: providedProjectIndex = null,
} = {}) {
  const projectIndex = useMemo(
    () => providedProjectIndex ?? buildProjectIndex(project),
    [project, providedProjectIndex],
  );

  const selectedNode = useMemo(
    () => buildSelectedNode(project, selectedId, projectIndex),
    [project, projectIndex, selectedId],
  );

  const allMenus = useMemo(
    () => collectAllMenus(project, projectIndex),
    [project, projectIndex],
  );

  const validationIssues = useMemo(
    () => getProjectValidationIssues(project, fileAudit, projectIndex),
    [project, fileAudit, projectIndex],
  );

  return {
    projectIndex,
    selectedNode,
    allMenus,
    validationIssues,
  };
}
