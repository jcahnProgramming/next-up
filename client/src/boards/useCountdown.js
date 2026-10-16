import { useEffect, useRef, useState } from 'react';

/**
 * Seconds left until a rate limit lifts, ticking once a second, from the server's retryAfter (seconds). Counts against
 * a deadline (Date.now), so a tab left in the background is still right when it comes back. Calls onDone once at 0.
 */
export function useCountdown(retryAfter, onDone) {
  const [deadline] = useState(() => Date.now() + retryAfter * 1000);
  const [left, setLeft] = useState(retryAfter);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        clearInterval(timer);
        done.current?.();
      }
    };
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [deadline]);

  return left;
}

/** 252 → "4:12" */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
