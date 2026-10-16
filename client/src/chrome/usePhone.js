import { useSyncExternalStore } from 'react';

// The phone layout's breakpoint, the same 600 px the CSS uses.
const PHONE = '(max-width: 600px)';

export function usePhone() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(PHONE);
      mq.addEventListener('change', onChange);
      return () => {
        mq.removeEventListener('change', onChange);
      };
    },
    () => window.matchMedia(PHONE).matches,
  );
}
