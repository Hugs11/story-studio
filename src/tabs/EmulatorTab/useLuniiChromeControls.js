import { useState } from 'react';

export function useLuniiChromeControls() {
  const [autoPlaybackEnabled, setAutoPlaybackEnabled] = useState(true);
  const [transparentPreview, setTransparentPreview] = useState(false);
  return {
    autoPlaybackEnabled,
    transparentPreview,
    toggleAutoPlayback: () => setAutoPlaybackEnabled((value) => !value),
    toggleTransparentPreview: () => setTransparentPreview((value) => !value),
  };
}
