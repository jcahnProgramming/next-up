import { useEffect, useRef, useState } from 'react';
import { ClockIcon, LockIcon, WarningIcon } from '../chrome/icons.jsx';
import { unlockBoard } from './api.js';
import { PasswordField } from './PasswordField.jsx';
import { Countdown } from './states.jsx';

/**
 * The lock screen (design/v1 Lock-Screen): all a password board shows without its password. Only the code that was
 * typed; nothing about the board.
 *
 *   entering · wrong · unlocking · too many tries (countdown) · couldn't check (not a wrong password)
 *   changed: this browser's saved access is for an older password → "The board's password changed."
 */
export function LockScreen({ code, changed = false, onUnlocked, onLookupLimited }) {
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState('entering'); // entering | wrong | unlocking | limited | error
  const [retryAfter, setRetryAfter] = useState(0);
  const input = useRef(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || phase === 'unlocking' || phase === 'limited') return;
    setPhase('unlocking');
    const result = await unlockBoard(code, password);
    if (result.kind === 'open') return onUnlocked(result.board);
    if (result.kind === 'limited' && result.what === 'lookups') return onLookupLimited(result.retryAfter);
    if (result.kind === 'limited') {
      setPassword('');
      setRetryAfter(result.retryAfter);
      return setPhase('limited');
    }
    if (result.kind === 'wrong') return setPhase('wrong');
    setPhase(result.kind === 'error' && result.offline ? 'offline' : 'error');
  };

  const limited = phase === 'limited';
  const unlocking = phase === 'unlocking';
  // Too many tries disables the field that had focus: move it to the heading that says why. A wrong password selects
  // what was typed, once the field is enabled again (it's disabled while checking), so typing replaces it.
  useEffect(() => {
    if (limited) document.getElementById('lock-title')?.focus({ preventScroll: true });
    if (phase === 'wrong' || phase === 'error' || phase === 'offline') input.current?.select();
  }, [limited, phase]);

  return (
    <div className="lock-wrap">
      {changed && !limited && (
        <p className="banner banner-info lock-banner" role="status">
          <LockIcon size={18} />
          <span className="banner-text">
            <b>The board’s password changed.</b> Enter the new one to keep going.
          </span>
        </p>
      )}
      <form
        className="lock glass-2"
        onSubmit={submit}
        aria-labelledby="lock-title"
        aria-busy={unlocking || undefined}
        noValidate
      >
        {limited ? (
          <>
            <span className="icon-circle ic-warn">
              <ClockIcon />
            </span>
            <h1 id="lock-title" className="display lock-title" tabIndex={-1}>
              Too many tries for now
            </h1>
            <p className="lock-text">Your network has entered a wrong password too many times. Wait a few minutes, then try again.</p>
            <Countdown retryAfter={retryAfter} onDone={() => setPhase('entering')} />
          </>
        ) : (
          <>
            <span className={`icon-circle ${unlocking ? 'ic-ok' : 'ic-accent'}`}>
              <LockIcon size={24} open={unlocking} />
            </span>
            <h1 id="lock-title" className="display lock-title">
              <span className="code-text">{code}</span> is locked
            </h1>
            {!changed && <p className="lock-text">This board has a password. Enter it to open the board.</p>}
          </>
        )}

        <div className="lock-form" style={limited ? { opacity: 0.5 } : undefined}>
          <PasswordField
            label={changed ? 'New board password' : 'Board password'}
            value={password}
            onChange={(v) => {
              setPassword(v);
              if (phase === 'wrong' || phase === 'error' || phase === 'offline') setPhase('entering');
            }}
            placeholder={limited ? 'Paused' : changed ? 'Ask whoever runs the board' : undefined}
            error={phase === 'wrong' ? "That password didn't work. Check with whoever runs the board." : undefined}
            disabled={limited || unlocking}
            busy={unlocking}
            autoFocus
            inputRef={input}
          />
          {(phase === 'error' || phase === 'offline') && (
            <p className="banner banner-err" role="alert">
              <WarningIcon />
              <span className="banner-text">
                {phase === 'offline' ? (
                  <>
                    <b>You’re offline.</b> Unlocking needs a connection. Try again when you’re back online.
                  </>
                ) : (
                  <>
                    <b>Couldn’t check it.</b> That’s not a wrong password: Next Up couldn’t be reached. Try again.
                  </>
                )}
              </span>
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={limited || (!password && !unlocking)}
            aria-disabled={unlocking || undefined}
          >
            {unlocking ? (
              <>
                <span className="spin" aria-hidden="true" />
                Unlocking…
              </>
            ) : phase === 'error' || phase === 'offline' ? (
              'Try again'
            ) : (
              'Unlock'
            )}
          </button>
        </div>
        {!limited && <span className="lock-caption">This browser remembers it until you tap the lock on the code chip.</span>}
      </form>
    </div>
  );
}
