import { useEffect, useId, useRef, useState } from 'react';
import { DATE_MAX_YEAR, DATE_MIN_YEAR, dateParts } from '../../../server/core/cardDetail.js';
import { MONTHS, addDays, addMonths, formatDate, monthGrid, relativeTo, todayString } from '../cards/dates.js';
import { Overlay } from './Overlay.jsx';
import { usePhone } from './usePhone.js';

/**
 * The themed date picker (design/v1 Components "Date picker", Detail-Edit, Detail-Phone 4; nu.css .dp). Never a
 * native <input type="date">: its popup ignores the theme. The value is a calendar date 'YYYY-MM-DD' or null
 * (cards/dates.js): picking "24" means the 24th for everyone, wherever they are.
 *
 *   <DatePicker labelledBy={id} value={goLive} onChange={setGoLive} />
 *
 * On a desktop it opens under its field and picking a day closes it. On a phone it is a bottom sheet of its own
 * (Detail-Phone 4): picking a day selects it, and Done closes. Both have "Clear date" and "Today".
 *
 * Keyboard: the days are one tab stop; arrows move a day or a week, Home/End to the week's ends, Page Up/Down a
 * month; Enter or Space picks. Escape closes without changing anything (and doesn't close the sheet it's in).
 */
export function DatePicker({ labelledBy, value, onChange, autoFocus = false, disabled = false }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const popId = useId();
  const valueId = useId();

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open || phone) return undefined;
    const away = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
    };
  }, [open, phone]);

  const today = todayString();
  return (
    <div className="dropdown-wrap dp-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dropdown"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open && !phone ? popId : undefined}
        aria-labelledby={`${labelledBy} ${valueId}`}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        data-autofocus={autoFocus || undefined}
      >
        <CalendarIcon />
        <span id={valueId} className={`dropdown-value${value ? '' : ' is-unset'}`}>{value ? formatDate(value) : 'Not set'}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
        </svg>
      </button>
      {open && !phone && (
        <div id={popId} className="dp dp-pop glass-2" role="dialog" aria-label="Choose the go-live date">
          <Calendar
            value={value}
            today={today}
            onPick={(date) => {
              onChange(date);
              close();
            }}
            onEscape={() => close()}
            foot={
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => (onChange(null), close())} disabled={!value}>
                  Clear date
                </button>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => (onChange(today), close())}>
                  Today
                </button>
              </>
            }
          />
        </div>
      )}
      {open && phone && <PhoneSheet value={value} today={today} onChange={onChange} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PhoneSheet({ value, today, onChange, onClose }) {
  const titleId = useId();
  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={onClose} className="dp-sheet">
      <div className="sheet-head">
        <h2 id={titleId} className="display sheet-title dp-sheet-title">
          Go-live date
        </h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="dp dp-in-sheet">
        <Calendar
          value={value}
          today={today}
          onPick={onChange}
          foot={
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)} disabled={!value}>
                Clear date
              </button>
              <span className="dp-summary" aria-live="polite">
                {value ? `${formatDate(value, { year: false })} · ${relativeTo(value, today).toLowerCase()}` : 'Not set'}
              </span>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(today)}>
                Today
              </button>
            </>
          }
        />
      </div>
    </Overlay>
  );
}

const FIRST = `${DATE_MIN_YEAR}-01-01`;
const LAST = `${DATE_MAX_YEAR}-12-31`;
const clamp = (d) => (d < FIRST ? FIRST : d > LAST ? LAST : d);
const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function Calendar({ value, today, onPick, onEscape, foot }) {
  const [focus, setFocus] = useState(() => value ?? today);
  const [keyed, setKeyed] = useState(false); // move real focus only once the keyboard is used in the grid
  const grid = useRef(null);
  const headId = useId();
  const { year, month } = dateParts(focus);
  const cells = monthGrid(year, month);

  // The focused day follows the value when it changes from outside (Today, Clear in the phone sheet).
  useEffect(() => {
    if (value) setFocus(value);
  }, [value]);

  useEffect(() => {
    if (keyed) grid.current?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  }, [focus, keyed]);

  // Opening puts focus on the selected day (or today), so the keyboard can start at once.
  useEffect(() => {
    grid.current?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  }, []);

  const go = (date) => {
    setKeyed(true);
    setFocus(clamp(date));
  };
  const onKeyDown = (e) => {
    const dow = (new Date(Date.UTC(year, month - 1, dateParts(focus).day)).getUTCDay() + 6) % 7;
    const moves = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      Home: () => addDays(focus, -dow),
      End: () => addDays(focus, 6 - dow),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
    };
    if (moves[e.key]) {
      e.preventDefault();
      go(moves[e.key]());
    } else if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
  };

  const canPrev = `${year}-${String(month).padStart(2, '0')}` > FIRST.slice(0, 7);
  const canNext = `${year}-${String(month).padStart(2, '0')}` < LAST.slice(0, 7);
  return (
    <div onKeyDown={onKeyDown}>
      <div className="dp-head">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setFocus(clamp(addMonths(focus, -1)))} disabled={!canPrev}>
          <Chevron d="M15 6l-6 6 6 6" />
        </button>
        <span id={headId} className="dp-month" aria-live="polite">
          {MONTHS[month - 1]} {year}
        </span>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setFocus(clamp(addMonths(focus, 1)))} disabled={!canNext}>
          <Chevron d="M9 6l6 6-6 6" />
        </button>
      </div>
      <div ref={grid} className="dp-grid" role="group" aria-labelledby={headId}>
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d, i) => (
          <abbr key={d} className="dp-dow" title={LONG_DAYS[i]}>
            {d}
          </abbr>
        ))}
        {cells.map((c) => {
          const real = dateParts(c.date) !== null;
          return (
            <button
              key={c.date}
              type="button"
              className={`dp-day${c.inMonth ? '' : ' is-out'}${c.date === today ? ' is-today' : ''}${c.date === value ? ' is-sel' : ''}`}
              tabIndex={c.date === focus ? 0 : -1}
              aria-pressed={c.date === value}
              aria-current={c.date === today ? 'date' : undefined}
              aria-label={real ? `${formatDate(c.date)}${c.date === today ? ', today' : ''}` : undefined}
              disabled={!real}
              onClick={() => {
                setFocus(c.date);
                onPick(c.date);
              }}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      <div className="dp-foot">{foot}</div>
    </div>
  );
}

function Chevron({ d }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function CalendarIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </svg>
  );
}
