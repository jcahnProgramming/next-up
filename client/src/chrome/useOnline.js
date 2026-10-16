import { useSyncExternalStore } from 'react';

/** Whether the browser thinks it's online (navigator.onLine), following its online / offline events. */
export function useOnline() {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('online', onChange);
      window.addEventListener('offline', onChange);
      return () => {
        window.removeEventListener('online', onChange);
        window.removeEventListener('offline', onChange);
      };
    },
    () => navigator.onLine !== false,
  );
}
