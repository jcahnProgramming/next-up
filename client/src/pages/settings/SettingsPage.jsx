import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckIcon, ChevronLeft, WarningIcon } from '../../chrome/icons.jsx';
import { cleanName, MAX_NAME, storageAvailable, useDisplayName } from '../../prefs/displayName.js';
import { setThemeChoice, THEMES, useThemeChoice } from '../../theme/theme.js';
import './settings.css';

// design/v1 Settings.dc.html. Theme and display name are per browser (localStorage), never an account, and never
// sent to the server. The "This board" section (the board's password) comes with boards; it isn't drawn here.
export function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [canStore] = useState(storageAvailable);
  // Back returns to wherever you came from; opened directly, it goes Home.
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate('/'));

  return (
    <div className="settings">
      <div className="settings-head">
        <button type="button" className="btn btn-ghost btn-sm settings-back" onClick={back}>
          <ChevronLeft />
          Back
        </button>
        <h1 className="settings-title display">Settings</h1>
      </div>

      {!canStore && (
        <p className="banner banner-warn" role="status">
          <WarningIcon />
          <span>
            <b>This browser isn't letting Next Up save settings.</b> Changes here work until you close or reload this
            page, then go back to how they were.
          </span>
        </p>
      )}

      <ThemeSection />
      <NameSection />
    </div>
  );
}

const OPTIONS = [{ id: null, name: 'Match device' }, ...THEMES];

function ThemeSection() {
  const choice = useThemeChoice();
  const buttons = useRef([]);
  const selected = Math.max(0, OPTIONS.findIndex((o) => o.id === choice));

  // A radio group: Tab reaches the chosen option, arrows move the choice (and apply it), as native radios do.
  const onKeyDown = (e, i) => {
    const n = OPTIONS.length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = (to + n) % n;
    setThemeChoice(OPTIONS[next].id);
    buttons.current[next]?.focus();
  };

  return (
    <section className="settings-section glass-1" aria-labelledby="settings-theme">
      <h2 id="settings-theme" className="settings-section-title">
        Theme <span className="settings-scope">this browser only</span>
      </h2>
      <div className="theme-grid" role="radiogroup" aria-labelledby="settings-theme">
        {OPTIONS.map((option, i) => (
          <button
            key={option.id ?? 'device'}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={i === selected}
            tabIndex={i === selected ? 0 : -1}
            className="theme-option"
            onClick={() => setThemeChoice(option.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {option.id ? (
              <ThemePreview theme={option.id} />
            ) : (
              <span className="theme-split">
                <ThemePreview theme="light" bare />
                <ThemePreview theme="dark" bare />
              </span>
            )}
            {i === selected && (
              <span className="theme-check">
                <CheckIcon size={12} />
              </span>
            )}
            <span className="theme-name">{option.name}</span>
          </button>
        ))}
      </div>
      <p className="field-hint settings-note">
        Match device uses Light or Dark, following this device's setting as it changes.
      </p>
    </section>
  );
}

// A miniature board drawn in the theme's own tokens: top bar, three lanes, two no-logo cards and a button. No game
// art: real cards only ever use logos from the repo.
function ThemePreview({ theme, bare = false }) {
  return (
    <span className="theme-shot" data-theme={theme} aria-hidden="true">
      <span className="theme-shot-bar" />
      {!bare && (
        <span className="theme-shot-lanes">
          <span className="theme-shot-lane">
            <span className="theme-shot-card" />
          </span>
          <span className="theme-shot-lane">
            <span className="theme-shot-card" />
          </span>
          <span className="theme-shot-lane">
            <span className="theme-shot-btn" />
          </span>
        </span>
      )}
    </span>
  );
}

function NameSection() {
  const [name, save] = useDisplayName();
  const [draft, setDraft] = useState(name ?? '');
  const [announce, setAnnounce] = useState('');

  // A name saved in another tab replaces what's shown here.
  useEffect(() => {
    setDraft(name ?? '');
  }, [name]);

  const clean = cleanName(draft);
  const dirty = clean !== (name ?? '');
  let label = 'Save';
  if (!dirty && name) label = 'Saved';
  else if (dirty && !clean) label = 'Clear name';

  const submit = (e) => {
    e.preventDefault();
    if (!dirty) return;
    const stored = save(clean);
    setDraft(clean);
    if (!clean) setAnnounce('Display name cleared.');
    else setAnnounce(stored ? 'Display name saved in this browser.' : 'Display name saved until this page closes.');
  };

  return (
    <section className="settings-section glass-1" aria-labelledby="settings-name">
      <h2 id="settings-name" className="settings-section-title">
        Display name <span className="settings-scope">this browser only</span>
        {!name && <span className="badge">Not set</span>}
      </h2>
      <form className="field" onSubmit={submit}>
        <div className="name-row">
          <input
            className="field-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_NAME}
            placeholder="Your name"
            aria-labelledby="settings-name"
            aria-describedby="settings-name-hint"
            autoComplete="nickname"
            spellCheck={false}
            enterKeyHint="done"
          />
          <button type="submit" className="btn btn-secondary" disabled={!dirty}>
            {label}
          </button>
        </div>
        <span id="settings-name-hint" className="field-hint">
          {name
            ? 'It will appear next to your changes in a board’s history.'
            : 'No name is set in this browser, so your changes show as “Someone”.'}{' '}
          A label, not an account: anyone can type any name.
        </span>
      </form>
      <p className="sr-only" role="status">{announce}</p>
    </section>
  );
}
