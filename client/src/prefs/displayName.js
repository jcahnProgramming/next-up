import { useCallback, useEffect, useState } from 'react';

// The display name is per browser (localStorage), a label and never an identity: anyone can type any name. Nothing
// on the server stores it. Every storage call is guarded: a browser that blocks storage throws on access, and then
// the name lasts only until this page closes.

const KEY = 'nu.displayName';
export const MAX_NAME = 32;

let inMemory = false;
let memory = null;

/** Trims and collapses whitespace; an empty result means "not set". */
export function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

export function readDisplayName() {
  if (inMemory) return memory;
  try {
    return cleanName(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}

/** Saves the name (empty clears it). Returns true if it was stored in this browser, false if only until it closes. */
export function writeDisplayName(value) {
  const name = cleanName(value) || null;
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
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
