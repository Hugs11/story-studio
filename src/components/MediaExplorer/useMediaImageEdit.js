import { useEffect, useRef, useState } from 'react';
import { readImageEditMetadata } from '../../store/imageEditMetadata';
import { getEditedImageTags } from '../../store/mediaLibrary';
import { pathKey } from '../../utils/fileUtils';
import { logger } from '../../utils/logger';

const SUCCESS_MESSAGE = 'Image modifiée créée dans Médias';

export function useMediaImageEdit({
  workspaceDir,
  mediaTags,
  onAddMediaTag,
  onMediaCreated,
  onCreated,
  showErrorDialog,
}) {
  const [editSession, setEditSession] = useState(null);
  const [notice, setNotice] = useState('');
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const editSessionRef = useRef(null);
  editSessionRef.current = editSession;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const session = editSessionRef.current;
    if (!session || pathKey(session.workspaceDir) === pathKey(workspaceDir)) return;
    requestIdRef.current += 1;
    editSessionRef.current = null;
    setEditSession(null);
  }, [workspaceDir]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function openImageEditor(item) {
    if (!item || item.kind !== 'image' || !item.exists) return;
    if (!workspaceDir?.trim() || !onMediaCreated) {
      showErrorDialog?.({
        title: 'Création impossible',
        message: 'Aucun dossier de projet durable n’est disponible. L’image source reste inchangée.',
        variant: 'warning',
      });
      return;
    }

    const requestId = ++requestIdRef.current;
    const metadata = await readImageEditMetadata(item.path);
    if (!mountedRef.current || requestId !== requestIdRef.current) return;

    const session = {
      requestId,
      item,
      workspaceDir,
      sourcePath: metadata?.sourcePath || item.path,
      initialTransform: metadata?.transform ?? null,
      initialFilters: metadata?.filters ?? null,
    };
    editSessionRef.current = session;
    setEditSession(session);
  }

  function closeImageEditor() {
    requestIdRef.current += 1;
    editSessionRef.current = null;
    setEditSession(null);
  }

  function handleImageEditorConfirm(path) {
    const session = editSessionRef.current;
    if (!path || !session) return;
    editSessionRef.current = null;
    setEditSession(null);

    if (!mountedRef.current || pathKey(session.workspaceDir) !== pathKey(workspaceDir)) {
      logger.warn('media:image-edit-result-orphaned-after-context-change', path);
      return;
    }

    onMediaCreated(path);
    for (const tag of getEditedImageTags(mediaTags, session.item.path)) {
      onAddMediaTag?.(path, tag);
    }
    onCreated?.(path);
    setNotice(SUCCESS_MESSAGE);
  }

  return {
    editSession,
    notice,
    openImageEditor,
    closeImageEditor,
    handleImageEditorConfirm,
  };
}
