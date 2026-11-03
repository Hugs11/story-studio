// One explicit exemplar; confirmation receipts belong to one immutable plan.
const ARCHIVE_REASONS = {
  shared: 'catalogue:trash.archiveShared',
  multiple: 'catalogue:trash.archiveShared',
  unavailable: 'catalogue:trash.archiveUnavailable',
  unreadable: 'catalogue:trash.archiveUnreadable',
  uninspectable: 'catalogue:trash.archiveUninspectable',
};
// The engine decides (`archiveRemoval`): a member follows it, a direct archive
// is only refused by it (several real packs, or contents that cannot be read).
export function trashAvailability(exemplar) {
  const policy = exemplar?.archiveRemoval;
  if (policy && (exemplar.member || policy.enabled === false)) {
    if (policy.enabled === true) return { enabled: true, reasonKey: null };
    return {
      enabled: false,
      reasonKey: Object.hasOwn(ARCHIVE_REASONS, policy.reason) ? ARCHIVE_REASONS[policy.reason] : 'catalogue:trash.archiveRefused',
      reasonParams: Number.isInteger(policy.packCount) ? { count: policy.packCount } : {},
    };
  }
  const format = exemplar?.technicalFormat ?? exemplar?.format;
  return ['zip', '7z', 'studioDirectory', 'fsDirectory', 'fsZip', 'project'].includes(format) && exemplar?.state === 'available'
    && exemplar.available !== false && exemplar.availability !== 'unavailable' && !exemplar.member && !exemplar.projectInUse
    ? { enabled: true, reasonKey: null }
    : { enabled: false, reasonKey: 'catalogue:actions.reason.noExemplar' };
}
export function removalConfirmation(dto) {
  if (!dto || !['trash', 'targets', 'irreversible'].includes(dto.stage)
    || !['planId', 'targetToken', 'token'].every(key => typeof dto[key] === 'string' && dto[key])) throw new TypeError('Invalid removal confirmation');
  return dto;
}
export function removalStage(plan, confirmations) {
  if (!plan || plan.targets.length !== 1) return null;
  if (plan.action === 'trash') return confirmations.length === 0 ? 'trash' : null;
  if (plan.action === 'deletePermanently') return ['targets', 'irreversible'][confirmations.length] ?? null;
  return null;
}
export function acceptRemovalConfirmation(plan, confirmations, dto) {
  const receipt = removalConfirmation(dto);
  if (receipt.planId !== plan.planId || receipt.targetToken !== plan.targets[0].sourceToken
    || receipt.stage !== removalStage(plan, confirmations) || confirmations.some(c => c.token === receipt.token)) throw new TypeError('Mismatched removal confirmation');
  return [...confirmations, receipt];
}
// One user gesture consumes the engine's ordered, target-bound receipts.
export async function launchRemoval(filesApi, plan, requestId) {
  let confirmations = [];
  for (let stage = removalStage(plan, confirmations); stage; stage = removalStage(plan, confirmations)) {
    const dto = await filesApi.confirmRemoval(plan.planId, stage, confirmations.at(-1)?.token ?? null);
    confirmations = acceptRemovalConfirmation(plan, confirmations, dto);
  }
  return filesApi.start(plan.planId, { summaryValidated: true, skipExemplarIds: [], removalConfirmations: confirmations.map(c => c.token) }, requestId);
}
export const TRASH_ARM_MS = 400;
export const TRASH_RESET_MS = 4000;
export function trashGestureArmed(appearedAt, now) { return now - appearedAt >= TRASH_ARM_MS; }
