import { removalConfirmation } from './trashPlan.js';
import { duplicatePage, checkerEntry } from './duplicateModel.js';
import { toCatalogueError } from './catalogueApi.js';
import { filePlan } from './filePlan.js';
export function createCatalogueFilesApi(bridge = {}) {
  async function call(command, args) {
    try { const invoke = bridge.invoke ?? (await import('@tauri-apps/api/core')).invoke; return await invoke(command, args); }
    catch (error) { throw toCatalogueError(error); }
  }
  return {
    preparePermanentDelete: async trashPlanId => filePlan(await call('catalogue_prepare_permanent_delete', { trashPlanId })),
    confirmRemoval: async (planId, stage, previousToken = null) => removalConfirmation(await call('catalogue_confirm_file_removal', { planId, stage, previousToken })),
    identicalCopies: (ficheId, requestId) => call('catalogue_identical_copies', { ficheId, requestId }),
    cancelIdenticalCopies: requestId => call('catalogue_cancel_identical_copies', { requestId }),
    findDuplicates: (scope, requestId) => call('catalogue_find_duplicates', { scope, requestId }),
    releaseDuplicateResults: operationId => call('catalogue_release_duplicate_results', { operationId }),
    duplicateResults: async (operationId, offset = 0, limit = 100) => duplicatePage(await call('catalogue_get_duplicate_results', { operationId, offset, limit })),
    prepareChecker: async (exemplarId, expectedRevision) => checkerEntry(await call('catalogue_prepare_checker_entry', { exemplarId, expectedRevision })),
    releaseChecker: preparationId => call('catalogue_release_checker_entry', { preparationId }),
    projectAccess: (action, path = null, token = null, workId = null) => call('catalogue_project_access', { action, path, token, workId }),
    plan: async (targets, options, action) => filePlan(await call('catalogue_plan_file_operation', { action, targets, options })),
    releasePlan: planId => call('catalogue_release_file_plan', { planId }),
    start: (planId, decisions, requestId) => call('catalogue_start_file_operation', { planId, decisions, requestId }),
  };
}
export const catalogueFilesApi = createCatalogueFilesApi();
