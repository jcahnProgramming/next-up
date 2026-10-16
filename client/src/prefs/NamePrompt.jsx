import { createContext, useCallback, useContext, useId, useRef, useState } from 'react';
import { Overlay } from '../chrome/Overlay.jsx';
import { usePhone } from '../chrome/usePhone.js';
import { MAX_NAME, cleanName, nameAnswered, writeDisplayName } from './displayName.js';
import './namePrompt.css';

/**
 * "Who's this?" (design/v1 Prompts): asked once per browser, at its first change (creating a board counts), never
 * just for opening one. Every change goes through askName() first:
 *
 *   const askName = useAskName();
 *   if (!(await askName('create pnc-autumn'))) return;   // closed without answering: make no change
 *
 * Resolves true straight away once this browser has answered. "Save and continue" stores the name; "Not now" stores
 * that the answer was no (changes log as "Someone") and it never asks again here. Closing it (Escape, the scrim)
 * answers nothing: the change isn't made, and the next change asks again.
 */
const NamePromptContext = createContext(async () => true);

export function NamePromptProvider({ children }) {
  const [pending, setPending] = useState(null); // { then, resolve }
  const queue = useRef(null);

  const askName = useCallback((then) => {
    if (nameAnswered()) return Promise.resolve(true);
    // One prompt at a time: a second change asked while it's open waits for the same answer.
    if (queue.current) return queue.current;
    queue.current = new Promise((resolve) => {
      setPending({
        then,
        resolve: (ok) => {
          queue.current = null;
          setPending(null);
          resolve(ok);
        },
      });
    });
    return queue.current;
  }, []);

  return (
    <NamePromptContext.Provider value={askName}>
      {children}
      {pending && <NamePrompt then={pending.then} onDone={pending.resolve} />}
    </NamePromptContext.Provider>
  );
}

export function useAskName() {
  return useContext(NamePromptContext);
}

function NamePrompt({ then, onDone }) {
  const titleId = useId();
  const phone = usePhone();
  const [draft, setDraft] = useState('');
  const name = cleanName(draft);

  const save = (e) => {
    e.preventDefault();
    if (!name) return;
    writeDisplayName(name);
    onDone(true);
  };
  const notNow = () => {
    writeDisplayName('');
    onDone(true);
  };

  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={() => onDone(false)}>
      <form className="modal-body" onSubmit={save} noValidate>
        <div className="name-prompt-head">
          <h2 id={titleId} className="display modal-title">
            Who’s this?
          </h2>
          <p className="modal-text">
            {phone
              ? 'A name for the board’s history. Just a label, not an account.'
              : 'Pick a name for the board’s history, so the guild can see who changed what.'}
          </p>
        </div>
        {then && (
          <p className="name-prompt-then">
            <PersonIcon />
            <span>
              Then: <b>{then}</b>
            </span>
          </p>
        )}
        <label className="field">
          <span className="field-label">Your name</span>
          <input
            className="field-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_NAME}
            placeholder="e.g. Larias"
            autoComplete="nickname"
            spellCheck={false}
            enterKeyHint="done"
            data-autofocus
          />
          {!phone && (
            <span className="field-hint">Just a label, not an account. Anyone can type any name, and you can change it in Settings.</span>
          )}
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={notNow}>
            Not now
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name}>
            Save and continue
          </button>
        </div>
        <span className="name-prompt-foot">Not now: your changes show as “Someone”.</span>
      </form>
    </Overlay>
  );
}

function PersonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}
