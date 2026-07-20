import { useCallback, useRef, useState } from 'react';
import {
  buildMediaAudioToolRequest,
  haveSameMediaPathMultiset,
  validateMediaAudioToolRequest,
} from '../store/mediaToolContext.js';

let requestSequence = 0;

function nextRequestId() {
  requestSequence += 1;
  return `media-tool-${Date.now()}-${requestSequence}`;
}

function invalidResult(code, reason) {
  return { ok: false, code, reason };
}

export function useMediaToolBridge({
  project,
  statusByPath,
  openMediaTab,
  mutations,
  showErrorDialog,
}) {
  const [activeRequest, setActiveRequest] = useState(null);
  const activeRequestRef = useRef(null);
  const projectRef = useRef(project);
  const statusByPathRef = useRef(statusByPath);
  const projectRevisionRef = useRef(0);
  const previousProjectRef = useRef(project);

  if (previousProjectRef.current !== project) {
    previousProjectRef.current = project;
    projectRevisionRef.current += 1;
  }
  projectRef.current = project;
  statusByPathRef.current = statusByPath;
  activeRequestRef.current = activeRequest;

  const openMediaAudioTool = useCallback((spec) => {
    const built = buildMediaAudioToolRequest({
      project: projectRef.current,
      statusByPath: statusByPathRef.current,
      entryIds: spec?.entryIds,
      origin: spec?.origin,
      tool: spec?.tool,
      requestId: nextRequestId(),
    });
    if (!built.valid) {
      showErrorDialog?.({
        title: 'Outil audio indisponible',
        message: built.reason,
        variant: 'warning',
      });
      return built;
    }
    const request = {
      ...built.request,
      status: 'pending',
      projectRevision: projectRevisionRef.current,
    };
    activeRequestRef.current = request;
    setActiveRequest(request);
    openMediaTab?.();
    return { valid: true, request };
  }, [openMediaTab, showErrorDialog]);

  const acknowledgeRequest = useCallback((requestId) => {
    setActiveRequest((current) => {
      if (!current || current.requestId !== requestId || current.status !== 'pending') return current;
      const next = { ...current, status: 'active' };
      activeRequestRef.current = next;
      return next;
    });
  }, []);

  const invalidateRequest = useCallback((requestId = null) => {
    setActiveRequest((current) => {
      if (requestId && current?.requestId !== requestId) return current;
      activeRequestRef.current = null;
      return null;
    });
  }, []);

  const validateRequest = useCallback((request) => {
    if (!request || activeRequestRef.current?.requestId !== request.requestId) {
      return { valid: false, code: 'inactive-request', reason: 'Cette opération contextuelle n’est plus active.' };
    }
    if (request.projectRevision !== projectRevisionRef.current) {
      return { valid: false, code: 'project-changed', reason: 'Le projet a changé pendant le traitement.' };
    }
    return validateMediaAudioToolRequest(projectRef.current, request, statusByPathRef.current);
  }, []);

  const applyProjectAction = useCallback(({ request, action, result }) => {
    const validation = validateRequest(request);
    if (!validation.valid) return invalidResult(validation.code, validation.reason);

    let outcome;
    if (action === 'replace-stories-with-assembly') {
      if (
        request.tool !== 'assemble'
        || !haveSameMediaPathMultiset(result?.inputPaths, request.sourcePaths)
      ) {
        return invalidResult('action-not-allowed', 'Les fichiers assemblés ne correspondent plus aux histoires sélectionnées.');
      }
      outcome = mutations.handleReplaceStoriesWithAssembledStory({
        request,
        outputPath: result?.createdPaths?.[0],
        logicalName: result?.logicalName,
      });
    } else {
      return invalidResult('unknown-action', 'Cette action projet n’est pas reconnue.');
    }

    if (!outcome?.ok) return invalidResult(outcome?.code ?? 'mutation-refused', outcome?.reason ?? 'La modification du projet a été refusée.');
    invalidateRequest(request.requestId);
    return outcome;
  }, [invalidateRequest, mutations, validateRequest]);

  return {
    activeRequest,
    openMediaAudioTool,
    acknowledgeRequest,
    invalidateRequest,
    validateRequest,
    applyProjectAction,
  };
}
