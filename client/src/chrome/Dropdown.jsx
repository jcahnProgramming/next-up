import { useEffect, useId, useRef, useState } from 'react';
import { CheckIcon } from './icons.jsx';

/**
 * The themed dropdown (design/v1 Components, nu.css .dd / .menu; styles in theme/base.css .dropdown*). Never a native
 * <select>: its popup ignores the theme. Use this one everywhere a list of choices is picked from.
 *
 *   <Dropdown labelledBy={id} value={lane} onChange={setLane} options={[{ value, label, icon? }]} />
 *
 * Keyboard: Enter, Space or the arrows open it; arrows move, Enter or Space picks, Escape closes without picking
 * (and doesn't close the sheet it's in), Tab closes. A click outside closes it.
 */
export function Dropdown({ labelledBy, value, onChange, options, disabled = false }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);
  const selected = options.find((o) => o.value === value) ?? options[0];

  const show = () => {
    setActive(Math.max(0, options.indexOf(selected)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (option) => {
    onChange(option.value);
    close();
  };

  useEffect(() => {
    if (!open) return undefined;
    list.current?.focus();
    const away = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);

  const onTriggerKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className="dropdown-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dropdown"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelledBy}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        {selected.icon}
        <span className="dropdown-value">{selected.label}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
        </svg>
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          className="dropdown-menu dropdown-pop glass-2"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === selected.value}
              className="dropdown-option"
              data-active={i === active ? '' : undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(o)}
            >
              {o.icon}
              {o.label}
              {o.value === selected.value && (
                <span className="dropdown-check">
                  <CheckIcon size={16} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
