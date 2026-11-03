import { toCatalogueError } from './catalogueApi.js';
export function createCatalogueAssemblyApi(bridge = {}) {
  async function call(command, args) {
    try { const invoke = bridge.invoke ?? (await import('@tauri-apps/api/core')).invoke; return await invoke(command, args); }
    catch (error) { throw toCatalogueError(error); }
  }
  return {
    retainTask: preparationId => call('catalogue_retain_assembly_task', { preparationId }),
    finishTask: leaseId => call('catalogue_finish_assembly_task', { leaseId }),
    transfer: args => call('catalogue_transfer_assembly', args),
    prepare: args => call('catalogue_prepare_assembly', args),
    release: preparationId => call('catalogue_release_assembly', { preparationId }),
    operation: operationId => call('catalogue_get_operation', { operationId, limit: 100 }),
    cancel: operationId => call('catalogue_cancel_operation', { operationId }),
  };
}
export const catalogueAssemblyApi = createCatalogueAssemblyApi();
