import { useCallback, useEffect, useRef, useState } from 'react';
import { catalogueDataApi } from '../store/catalogue/catalogueDataApi.js';
export function useCatalogueTags(api = catalogueDataApi) {
  const generation = useRef(0);
  const [state, setState] = useState({ revision: null, items: [], error: null });
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try { const result = await api.listTags(); if (request === generation.current) setState({ ...result, error: null }); return result; }
    catch (error) { if (request === generation.current) setState(current => ({ ...current, error })); return null; }
  }, [api]);
  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [reload]);
  return { ...state, reload };
}
