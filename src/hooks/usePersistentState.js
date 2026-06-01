import { useEffect, useState } from 'react';
import { read as readSetting, write as writeSetting } from '../store/persistentSettings';

/**
 * `useState` + persistence dans `localStorage` via `persistentSettings`.
 *
 * - `decode(rawString) -> value` : transforme la valeur lue (string) en valeur typée.
 * - `encode(value) -> rawString` : transforme la valeur typée avant écriture.
 *
 * Sans decode/encode, le hook lit/écrit des strings brutes — comportement par défaut
 * équivalent à `useState(() => readSetting(key) ?? defaultValue)` + `useEffect(write…)`.
 */
export function usePersistentState(key, defaultValue, { decode, encode } = {}) {
  const [value, setValue] = useState(() => {
    const raw = readSetting(key);
    if (raw == null) return defaultValue;
    return decode ? decode(raw) : raw;
  });
  useEffect(() => {
    writeSetting(key, encode ? encode(value) : value);
  }, [key, value, encode]);
  return [value, setValue];
}
