import { createContext, useContext } from 'react';

export const ProjectContext = createContext({
  savePath: null,
  projectName: '',
  workspaceDir: '',
  globalOptions: {},
  xttsSettings: {},
  sdSettings: {},
  sdJobs: [],
  xttsJobs: [],
  pathAudit: {},
  onImportFile: async (path) => path,
  onExtractAudioEmbeddedImage: async () => null,
  onSave: null,
  onOpenSDGenerate: null,
  onRemoveSdResult: null,
  onUpdateXttsSettings: null,
  onQueueXttsGenerate: async () => null,
  onMediaCreated: null,
});

export const useProjectContext = () => useContext(ProjectContext);
