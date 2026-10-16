import { useCallback, useEffect, useState } from 'react';

// The display name is per browser (localStorage), a label and never an identity: anyone can type any name. Nothing
// on the server stores it. Every storage call is guarded: a browser that blocks storage throws on access, and then
// the name lasts only until this page closes.
//
// One key, three states:
//   absent      never asked: the name prompt (NamePrompt.jsx) asks at this browser's first change
//   ""          asked, and the answer was "Not now" (or the name was cleared in Settings): changes log as "Someone",
//               and nothing asks again
//   "Larias"    the name

const KEY = 'nu.displayName';
export const MAX_NAME = 32;

let inMemory = false;
let memory = null; // null: never asked; '': not now; else the name

/** Trims and collapses whitespace; an empty result means "not set". */
export function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

export function readDisplayName() {
  if (inMemory) return memory || null;
  try {
    return cleanName(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}

/** Whether this browser has answered the name prompt (a name, or "Not now"). */
export function nameAnswered() {
  if (inMemory) return memory !== null;
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return memory !== null;
  }
}

/**
 * Saves the name. Empty means "no name" and still counts as answered, so the prompt doesn't come back (that is how
 * "Not now" is kept). Returns true if it was stored in this browser, false if only until it closes.
 */
export function writeDisplayName(value) {
  const name = cleanName(value);
  try {
    localStorage.setItem(KEY, name);
    inMemory = false;
  } catch {
    inMemory = true;
    memory = name;
  }
  return !inMemory;
}

/** [name or null, save(value) → stored?]. Follows changes made in another tab. */
export function useDisplayName() {
  const [name, setName] = useState(readDisplayName);

  useEffect(() => {
    const onStorage = (e) => {
      if (!e.key || e.key === KEY) setName(readDisplayName());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const save = useCallback((value) => {
    const stored = writeDisplayName(value);
    setName(readDisplayName());
    return stored;
  }, []);

  return [name, save];
}

/** Whether this browser lets the app keep settings at all (checked once, by writing and removing a probe). */
export function storageAvailable() {
  try {
    const probe = 'nu.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}
