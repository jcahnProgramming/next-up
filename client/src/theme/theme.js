import { useSyncExternalStore } from 'react';

// The theme is per browser. The boot script in client/index.html owns it (window.nuTheme): it applies the choice
// before first paint, follows the device while nothing is chosen, and picks up changes from other tabs. This module
// only reads and changes it through that script, so the two can never disagree.

export const THEMES = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'legacy', name: 'Legacy' },
  { id: 'pastel', name: 'Pastel' },
  { id: 'cyberpunk', name: 'Cyberpunk' },
];

function subscribe(onChange) {
  window.addEventListener('nu-theme', onChange);
  return () => {
    window.removeEventListener('nu-theme', onChange);
  };
}

const getChoice = () => window.nuTheme?.choice() ?? null;

/** The chosen theme id, or null for "Match device". Re-renders when it changes, here or in another tab. */
export function useThemeChoice() {
  return useSyncExternalStore(subscribe, getChoice);
}

/**
 * Chooses a theme (null clears the choice so the device's light or dark setting decides). Applies at once with the
 * tokens' cross-fade. Returns false when the browser wouldn't store it, so it lasts only until this page closes.
 */
export function setThemeChoice(id) {
  return window.nuTheme ? window.nuTheme.set(id) : false;
}
