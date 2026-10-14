import { useSyncExternalStore } from 'react';
import type { AppState } from '../types';
export function useSessionState(store: { subscribe: (listener: () => void) => () => void; getSnapshot: () => AppState }) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
