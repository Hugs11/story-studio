/** A mounted funnel retains its inputs until all native consumers have settled. */
export function createEditorExtractionOwner({ ownerId, release }) {
  let pending = 0;
  let closed = false;
  let released = null;
  function clean() {
    if (!closed || pending || released) return;
    released = Promise.resolve().then(() => release(ownerId)).catch(() => {});
  }
  return {
    ownerId,
    async run(action) {
      if (closed) return { status: 'cancelled' };
      pending += 1;
      try { return await action(); }
      finally { pending -= 1; clean(); }
    },
    close() { closed = true; clean(); },
  };
}
