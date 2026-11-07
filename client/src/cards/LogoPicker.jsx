import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckIcon } from '../chrome/icons.jsx';
import { LogoThumb } from './Card.jsx';
import { LOGOS, logoById } from './logos.js';

/**
 * The logo dropdown (design/v1 Logo-Picker, nu.css .lcb-*): a searchable themed combobox over the logo library.
 * "No logo" is pinned first and previews the no-logo card with this card's initials. Then one row per game with a
 * small thumbnail; a search narrows them ("2 matches", or "No logos match"). With an empty library it says so.
 *
 *   value: a logo id or null · onChange(id | null, logo | null) · title: the card's title, for the preview
 */
export function LogoPicker({ labelledBy, value, onChange, title, disabled = false }) {
  const listId = useId();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const trigger = useRef(null);
  const search = useRef(null);
  const listbox = useRef(null);
  const current = logoById(value);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? LOGOS.filter((l) => l.name.toLowerCase().includes(q) || l.id.includes(q.replace(/\s+/g, '-'))) : LOGOS;
  }, [query]);
  // Row 0 is "No logo"; rows 1.. are the matches.
  const rows = [null, ...matches];

  const show = () => {
    setQuery('');
    setActive(current ? Math.max(0, LOGOS.indexOf(current) + 1) : 0);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (logo) => {
    onChange(logo?.id ?? null, logo);
    close();
  };

  useEffect(() => {
    if (!open) return undefined;
    (search.current ?? listbox.current)?.focus();
    const away = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);

  // Keep the keyboard's row in view.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[active] !== undefined) pick(rows[active]);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const optionProps = (i) => ({
    id: `${listId}-${i}`,
    role: 'option',
    'data-active': i === active ? '' : undefined,
    onPointerEnter: () => setActive(i),
  });

  return (
    <div className="lcb" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="lcb-field"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelledBy} ${valueId}`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <LogoThumb logoId={current?.id ?? null} title={title} />
        <span id={valueId} className="lcb-value">{current ? current.name : 'No logo'}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
        </svg>
      </button>

      {open && (
        <div className="lcb-pop glass-2">
          {LOGOS.length > 0 && (
            <label className="lcb-search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-4-4" />
              </svg>
              <input
                ref={search}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(e.target.value.trim() ? 1 : 0);
                }}
                onKeyDown={onKey}
                placeholder="Search logos"
                aria-label="Search logos"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={`${listId}-${active}`}
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button type="button" className="icon-btn icon-btn-dot" aria-label="Clear search" onClick={() => setQuery('')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </label>
          )}

          <div
            ref={listbox}
            id={listId}
            className="lcb-list"
            role="listbox"
            aria-label="Logos"
            tabIndex={LOGOS.length > 0 ? undefined : -1}
            aria-activedescendant={LOGOS.length > 0 ? undefined : `${listId}-${active}`}
            onKeyDown={LOGOS.length > 0 ? undefined : onKey}
          >
            <div {...optionProps(0)} aria-selected={!current} className={`lcb-row${!current ? ' is-selected' : ''}`} onClick={() => pick(null)}>
              <LogoThumb logoId={null} title={title} />
              <span className="lcb-text">
                <span>No logo</span>
                <span className="lcb-sub">Solid colour with the game’s name</span>
              </span>
              {!current && <CheckIcon size={16} />}
            </div>
            <span className="lcb-rule" role="presentation" />

            {LOGOS.length === 0 ? (
              <div className="st-empty lcb-empty" role="presentation">
                <span className="lcb-empty-title">No logos yet</span>
                <span className="lcb-empty-text">Cards use a colour until logos are added.</span>
              </div>
            ) : matches.length === 0 ? (
              <div className="st-empty lcb-empty" role="presentation">
                <span className="lcb-empty-title">No logos match “{query.trim()}”</span>
                <span className="lcb-empty-text">Logos are added to the library by Path.</span>
              </div>
            ) : (
              <>
                {query.trim() && (
                  <span className="lcb-count" role="presentation" aria-live="polite">
                    {matches.length} {matches.length === 1 ? 'match' : 'matches'}
                  </span>
                )}
                {matches.map((logo, i) => {
                  const sel = current?.id === logo.id;
                  return (
                    <div
                      key={logo.id}
                      {...optionProps(i + 1)}
                      aria-selected={sel}
                      className={`lcb-row${sel ? ' is-selected' : ''}`}
                      onClick={() => pick(logo)}
                    >
                      <LogoThumb logoId={logo.id} title={logo.name} />
                      <span className="lcb-text">{logo.name}</span>
                      {sel && <CheckIcon size={16} />}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
