export function useSyncedRef(ref, value) {
  ref.current = value;
  return ref;
}
