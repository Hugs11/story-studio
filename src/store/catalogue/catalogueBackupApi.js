import { importSummary, importPage, importResult } from './importPreviewState.js';
import { toCatalogueError } from './catalogueApi.js';
import { exportPlan, exportReceipt, exportResult } from './backupExportState.js';
export function createCatalogueBackupApi(bridge = {}) {
  async function call(command, args) {
    try {
      const invoke = bridge.invoke ?? (await import('@tauri-apps/api/core')).invoke;
      return await invoke(command, args);
    } catch (error) { throw toCatalogueError(error); }
  }
  return {
    previewImport: async (path, requestId, associations = {}) => exportReceipt(await call('catalogue_preview_import', { path, requestId, associations })),
    importPage: async (previewId, offset = 0) => importPage(await call('catalogue_get_import_preview', { previewId, offset, limit: 100 })),
    applyImport: async args => exportReceipt(await call('catalogue_apply_import', args)),
    importOperation: async (operationId, mode) => {
      const dto = await call('catalogue_get_operation', { operationId, limit: 100 });
      if (!dto || dto.operationId !== operationId || !Number.isSafeInteger(dto.sequence) || dto.sequence < 0
        || !['queued', 'running', 'cancelling', 'success', 'failed', 'partial', 'cancelled'].includes(dto.status)) throw new TypeError('Invalid import operation');
      if (dto.status === 'success') (mode === 'preview' ? importSummary : importResult)(dto.result);
      return dto;
    },
    plan: async (destinationPath, expectedCatalogueRevision) => exportPlan(await call('catalogue_plan_export', { destinationPath, expectedCatalogueRevision })),
    start: async (planId, decisions, requestId) => exportReceipt(await call('catalogue_start_export', { planId, decisions, requestId })),
    operation: async operationId => {
      const dto = await call('catalogue_get_operation', { operationId, limit: 100 });
      if (!dto || typeof dto.operationId !== 'string' || !Number.isSafeInteger(dto.sequence) || dto.sequence < 0
        || !['queued', 'running', 'cancelling', 'success', 'failed', 'partial', 'cancelled'].includes(dto.status)) throw new TypeError('Invalid catalogue export operation');
      if (dto.status === 'success') exportResult(dto.result);
      return dto;
    },
    cancel: operationId => call('catalogue_cancel_operation', { operationId }),
  };
}
export const catalogueBackupApi = createCatalogueBackupApi();
