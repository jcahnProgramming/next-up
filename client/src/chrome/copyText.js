/**
 * Copies text to the clipboard. Resolves true if it worked. The Clipboard API exists only on secure pages (the public
 * site, localhost); on the LAN port over plain http it doesn't, so this falls back to a hidden textarea and the
 * older copy command.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the older way
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  const before = document.activeElement;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (before && typeof before.focus === 'function') before.focus({ preventScroll: true });
  return ok;
}
