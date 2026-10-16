/**
 * This browser tab's id: random, made when the page loads, kept nowhere. The API calls send it (X-NU-Tab) and the
 * live stream names it, so the stream can mark the tab's own changes, which it already shows (no flash, no "changed
 * by"). It identifies a tab for a moment, not a person, and is never stored by the server.
 */
export const TAB_ID = makeId();

function makeId() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `t${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
