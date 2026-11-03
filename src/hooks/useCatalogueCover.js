import { useEffect, useRef, useState } from 'react';
import { pickImage } from './useFileDialog.js';
import { catalogueDataApi } from '../store/catalogue/catalogueDataApi.js';
export function useCatalogueCover(api = catalogueDataApi) {
  const staged = useRef([]); const active = useRef(true); const [error, setError] = useState(null);
  useEffect(() => { active.current = true; return () => { active.current = false; void api.discardCovers(staged.current).catch(() => {}); }; }, [api]);
  async function choose() {
    try { setError(null); const path = await pickImage(); if (!path) return null;
      const image = await api.stageCover(path);
      if (!active.current) { await api.discardCovers([image.coverStagingId]); return null; }
      staged.current.push(image.coverStagingId); return image;
    } catch (error) { if (active.current) setError(error); return null; }
  }
  return { choose, error };
}
