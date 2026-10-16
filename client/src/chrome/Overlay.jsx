import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePhone } from './usePhone.js';
import './overlay.css';

/**
 * A dialog over the page (design/v1 nu.css .scrim / .modal / .sheet-side / .bsheet):
 *
 *   kind="modal"   centred card (the name prompt, confirmations)
 *   kind="side"    a sheet down the right edge (card detail and edit, Detail-Desktop / Detail-Edit)
 *
 * On a phone both become a bottom sheet with a grabber (Detail-Phone, Prompts). Rendered on <body> so the blurred
 * scrim covers everything. Focus moves in (to [data-autofocus], else the first control), Tab stays inside, Escape
 * or the scrim closes (onClose), and focus goes back where it was. While open, the page behind doesn't scroll.
 *
 * Escape is handled on the panel, so a dropdown inside that uses Escape to close itself calls stopPropagation and
 * the sheet stays open. A dialog opened from inside another closes alone.
 */
export function Overlay({ kind = 'modal', labelledBy, onClose, className = '', children }) {
  const phone = usePhone();
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const before = document.activeElement;
    const el = panel.current;
    const first = el.querySelector('[data-autofocus]') ?? focusables(el)[0] ?? el;
    first.focus({ preventScroll: true });
    return () => {
      if (before && before.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    lockScroll(1);
    return () => {
      lockScroll(-1);
    };
  }, []);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(panel.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const where = phone ? 'bottom' : kind;
  return createPortal(
    <div className={`ov ov-${where}`}>
      <div className="ov-scrim" aria-hidden="true" onClick={() => close.current?.()} />
      <div
        ref={panel}
        className={`ov-panel glass-2 ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {phone && <span className="ov-grabber" aria-hidden="true" />}
        {children}
      </div>
    </div>,
    document.body,
  );
}

function focusables(root) {
  return [
    ...root.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
  ].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

let locks = 0;
function lockScroll(delta) {
  locks += delta;
  document.documentElement.classList.toggle('ov-open', locks > 0);
}
