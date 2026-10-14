import { createContext, useContext, useEffect, useId } from 'react';

export const UnsavedChangesContext = createContext<(id: string, dirty: boolean) => void>(() => {});
export function useUnsavedChanges(dirty: boolean) {
  const register = useContext(UnsavedChangesContext), id = useId();
  useEffect(() => { register(id, dirty); return () => register(id, false); }, [register, id, dirty]);
}
