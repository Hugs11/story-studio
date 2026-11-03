import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createCoverLoading, initialCoverState, coverAttemptAddress } from '../store/catalogue/coverLoading.js';
import { cachedCoverBlob, coverBlobMode, loadCoverBlob } from '../store/catalogue/coverDisplay.js';

// Keep the last ready image only for this fiche while a new fingerprint loads.
// `blob`: the page cannot put the address in <img> directly (coverDisplay.js);
// the image then receives a blob URL once its bytes are fetched.
export function useCatalogueCoverImage(address, ficheId = address, { blob = coverBlobMode(), load = loadCoverBlob } = {}) {
  const [, setBlobs] = useState(0);
  const image = useRef(null);
  const loading = useRef(null);
  const [snapshot, setSnapshot] = useState(() => ({ address, ficheId, value: initialCoverState(address), ready: null }));
  const state = snapshot.address === address && snapshot.ficheId === ficheId ? snapshot.value : initialCoverState(address);
  const canKeep = ['waiting', 'loading', 'offline'].includes(state.phase);
  const previous = snapshot.ficheId === ficheId ? snapshot.ready : null;
  const fallbackSrc = canKeep ? previous : null;
  useLayoutEffect(() => {
    const changed = value => setSnapshot(old => ({
      address, ficheId, value: { ...value, fade: value.fade && !(old.ficheId === ficheId && old.ready) },
      ready: value.phase === 'ready' ? coverAttemptAddress(address, value.attempt)
        : ['waiting', 'loading', 'offline'].includes(value.phase) && old.ficheId === ficheId ? old.ready : null,
    }));
    changed(initialCoverState(address));
    const current = createCoverLoading({ address, changed });
    loading.current = { address, current };
    current.start(image.current);
    return () => { current.dispose(); loading.current = null; };
  }, [address, ficheId]);
  const current = () => loading.current?.address === address ? loading.current.current : null;
  const src = ['waiting', 'loading', 'ready'].includes(state.phase) ? coverAttemptAddress(address, state.attempt) : null;
  const pendingBlob = blob && src && !cachedCoverBlob(src) ? src : null;
  useEffect(() => {
    if (!pendingBlob) return undefined;
    let live = true;
    void load(pendingBlob).then(ready => {
      if (!live) return;
      // A failed fetch is an image error: the usual HEAD diagnosis follows.
      if (ready) setBlobs(n => n + 1);
      else void (loading.current?.address === address ? loading.current.current : null)?.failed();
    });
    return () => { live = false; };
  }, [pendingBlob, address, load]);
  const shown = value => !blob || !value ? value : cachedCoverBlob(value);
  return { image, state, fallbackSrc: shown(fallbackSrc), src: shown(src),
    onLoad: () => current()?.loaded(), onError: () => { void current()?.failed(); } };
}
