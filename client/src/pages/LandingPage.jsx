import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ErrorIcon, RetryIcon, WarningIcon } from '../chrome/icons.jsx';
import { lookupBoard } from '../boards/api.js';
import { checkCode } from '../boards/codes.js';
import { CreateBoard } from '../boards/CreateBoard.jsx';
import { BoardLimit, TooManyLookups } from '../boards/states.jsx';
import '../boards/boards.css';
import './landing.css';

// The front door (design/v1 Landing-Desktop, Landing-States, Landing-Phone): one box for a board's code. An existing
// code opens its board (or its lock screen); a free one offers to create it.
//
//   typing · opening · free (create?) · too many lookups · board limit reached · error (code kept)
const MAX_TYPED = 64; // past the 32-character limit, so a pasted long code shows an error instead of being cut off

export function LandingPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState({ kind: 'typing' });
  const [showError, setShowError] = useState(false);
  const inputRef = useRef(null);

  const check = checkCode(code);
  // Bad characters show at once; too short only once you try to go (everyone is "too short" while typing).
  const badChars = /[^a-z0-9-]/i.test(code.trim());
  const inlineError = code.trim() && (badChars || showError) && !check.ok ? check.error : null;

  const backToTyping = useCallback(() => {
    setPhase({ kind: 'typing' });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const open = async (e) => {
    e?.preventDefault();
    if (phase.kind === 'opening') return;
    setShowError(true);
    if (!check.ok) return;
    setPhase({ kind: 'opening', code: check.code });
    const result = await lookupBoard(check.code);
    if (result.kind === 'open' || result.kind === 'locked') return navigate(`/b/${check.code}`);
    if (result.kind === 'free') return setPhase(result.full ? { kind: 'full', code: check.code } : { kind: 'free', code: check.code });
    if (result.kind === 'limited') return setPhase({ kind: 'limited', retryAfter: result.retryAfter });
    setPhase({ kind: 'error', offline: result.offline });
  };

  const busy = phase.kind === 'opening';
  const blocked = phase.kind === 'limited';
  const creating = phase.kind === 'free';
  const errored = phase.kind === 'error';

  const codeBox = (
    <form className={`code-form${errored || inlineError ? ' is-error' : ''}${blocked ? ' is-paused' : ''}`} onSubmit={open} noValidate>
      <label htmlFor="board-code" className="sr-only">
        Board code
      </label>
      <input
        id="board-code"
        ref={inputRef}
        className="code-input"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setShowError(false);
          if (errored) setPhase({ kind: 'typing' });
        }}
        placeholder="Board code"
        maxLength={MAX_TYPED}
        disabled={busy || blocked}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        aria-invalid={inlineError ? 'true' : undefined}
        aria-describedby={inlineError ? 'code-error' : errored ? 'code-failed' : 'code-hint'}
      />
      <button
        type="submit"
        className="code-go"
        disabled={!code.trim() || blocked || creating}
        aria-disabled={busy || undefined}
        aria-label={errored ? 'Try again' : 'Open board'}
      >
        {busy ? <span className="spin" aria-hidden="true" /> : errored ? <RetryIcon /> : <ArrowRight />}
      </button>
    </form>
  );

  let body;
  if (phase.kind === 'limited') {
    body = (
      <TooManyLookups retryAfter={phase.retryAfter} onDone={backToTyping}>
        {codeBox}
      </TooManyLookups>
    );
  } else if (phase.kind === 'full') {
    body = <BoardLimit code={phase.code} onBack={backToTyping} />;
  } else {
    body = (
      <div className="landing-intro">
        <span className="landing-mark" aria-hidden="true">
          <ArrowRight size={34} />
        </span>
        <h1 id="landing-title" className="landing-title display">
          What are we playing next?
        </h1>
        <p className="landing-sub">Type your board’s code to open it. A code nobody has used yet makes a new board.</p>
        {codeBox}
        {inlineError && (
          <p id="code-error" className="field-error landing-error" role="alert">
            <ErrorIcon />
            {inlineError}
          </p>
        )}
        {busy && (
          <p className="landing-status" aria-live="polite">
            Opening <span className="code-text">{phase.code}</span>…
          </p>
        )}
        {errored && (
          <p id="code-failed" className="banner banner-err landing-banner" role="alert">
            <WarningIcon />
            <span className="banner-text">
              <b>{phase.offline ? "You're offline." : "Couldn't reach Next Up."}</b> Check your connection, then try again.
            </span>
          </p>
        )}
        {!inlineError && !busy && !errored && (
          <p id="code-hint" className="landing-hint">
            Letters, numbers and hyphens. A board without a password opens for anyone with its code, so share codes like
            keys.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`landing${creating ? ' is-creating' : ''}`}>
      <section className="landing-sheet glass-2" aria-labelledby={phase.kind === 'typing' || busy || errored || creating ? 'landing-title' : undefined}>
        {body}
        {creating && (
          <CreateBoard
            code={phase.code}
            sheetOnPhone
            onBack={backToTyping}
            onCreated={(board) => navigate(`/b/${board.code}`)}
            onLimited={(retryAfter) => setPhase({ kind: 'limited', retryAfter })}
            onFull={() => setPhase({ kind: 'full', code: phase.code })}
            onTaken={() => navigate(`/b/${phase.code}`)}
          />
        )}
      </section>
    </div>
  );
}
