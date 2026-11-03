// Each launch owns its cancellation intent before its native receipt exists.
// Dependencies are injected so deferred IPC and relaunches can be exercised.
export function createDuplicateRequest({ find, cancel, onCancelError }) {
  let current = null;
  async function applyCancellation(request) {
    if (!request.receipt || !request.cancelRequested) return;
    if (!request.cancelling) {
      request.cancelling = Promise.resolve().then(() => cancel(request.receipt.operationId));
      try { await request.cancelling; }
      catch (error) { request.cancelling = null; throw error; }
    } else await request.cancelling;
  }
  return {
    async start(scope, requestId) {
      const request = { receipt: null, cancelRequested: false, cancelling: null };
      current = request;
      request.receipt = await find(scope, requestId);
      try { await applyCancellation(request); }
      catch (error) { onCancelError(error); }
      return request.receipt;
    },
    async cancel() {
      const request = current;
      if (!request) return;
      request.cancelRequested = true;
      await applyCancellation(request);
    },
    finish(operationId) { if (current?.receipt?.operationId === operationId) current = null; },
  };
}
