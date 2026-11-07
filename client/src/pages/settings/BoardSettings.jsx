import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LockIcon, RestoreIcon, TrashIcon, WarningIcon } from '../../chrome/icons.jsx';
import { Overlay } from '../../chrome/Overlay.jsx';
import { useTopbar } from '../../chrome/topbar.jsx';
import { changePassword, lookupBoard } from '../../boards/api.js';
import { checkNewPassword } from '../../boards/codes.js';
import { DeleteBoard, formatLeft, RestoreBoard, useTimeLeft, withDeadline } from '../../boards/Deletion.jsx';
import { PasswordField } from '../../boards/PasswordField.jsx';
import { Countdown } from '../../boards/states.jsx';
import { useAskName } from '../../prefs/NamePrompt.jsx';

/**
 * Settings' "This board" (design/v1 Settings.dc.html, built to CLAUDE.md where they differ): change password
 * (password boards only) and delete board. Shown only for a board this browser can open: Settings asks the server
 * first, and a board that answers locked (or free, or "too many tries") gets no section at all.
 *
 * There is no "set password" or "remove password": a password is chosen only when a board is created, and once
 * chosen it can be changed, never removed. While the board is being deleted, the section shows the countdown and
 * Restore instead; nothing else about the board can change until then.
 */
export function BoardSettings({ code }) {
  const [state, setState] = useState({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    lookupBoard(code).then((r) => {
      if (!live) return;
      if (r.kind === 'open') setState({ kind: 'open', board: r.board, deletion: withDeadline(r.board.deletion) });
      else if (r.kind === 'error') setState({ kind: 'error', offline: r.offline });
      else setState({ kind: 'none' });
    });
    return () => {
      live = false;
    };
  }, [code, attempt]);

  const update = (board) => setState({ kind: 'open', board, deletion: withDeadline(board?.deletion) });

  if (state.kind === 'none') return null;
  return (
    <section className="settings-section glass-1" aria-labelledby="settings-board" aria-busy={state.kind === 'loading' || undefined}>
      <h2 id="settings-board" className="settings-section-title">
        This board <span className="code-text settings-scope">{code}</span>
      </h2>
      {state.kind === 'loading' && (
        <p className="board-settings-loading">
          <span className="spin" aria-hidden="true" />
          Checking this board…
        </p>
      )}
      {state.kind === 'error' && (
        <p className="banner banner-err" role="alert">
          <WarningIcon />
          <span className="banner-text">
            <b>{state.offline ? 'You’re offline.' : 'Couldn’t reach Next Up.'}</b> This board’s settings need a
            connection. Nothing has changed.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {state.kind === 'changed' && <PasswordChangedHere code={code} />}
      {state.kind === 'open' &&
        (state.deletion ? (
          <Deleting code={code} deletion={state.deletion} onBoard={update} onLost={setState} />
        ) : (
          <>
            {state.board.hasPassword ? (
              <ChangePassword code={code} onBoard={update} onLost={setState} />
            ) : (
              <div className="pw-state">
                <span className="icon-circle icon-circle-row ic-neutral">
                  <LockIcon size={18} open />
                </span>
                <span className="pw-state-text">
                  <span className="pw-state-title">No password</span>
                  <span className="pw-state-sub">
                    Anyone with the code can open and edit this board. A password can only be chosen when a board is
                    created, so this one stays open.
                  </span>
                </span>
              </div>
            )}
            <hr className="settings-rule" />
            <DeleteRow code={code} onBoard={update} onLost={setState} />
          </>
        ))}
    </section>
  );
}

// The password changed under us (someone else changed it while Settings was open): this browser's access is for the
// old one. The board's lock screen takes the new one.
function PasswordChangedHere({ code }) {
  const navigate = useNavigate();
  return (
    <div className="banner banner-info" role="alert">
      <LockIcon size={18} />
      <span className="banner-text">
        <b>The board’s password changed.</b> Someone else changed it while this page was open. Open the board and enter
        the new one to keep going.
      </span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate(`/b/${code}`)}>
        Open board
      </button>
    </div>
  );
}

// What any change here does when the board turns out to have moved on: locked (the password changed), free (purged),
// or being deleted (someone deleted it meanwhile).
function lost(r, { onBoard, onLost }) {
  if (r.kind === 'locked') onLost({ kind: r.changed ? 'changed' : 'none' });
  else if (r.kind === 'free') onLost({ kind: 'none' });
  else if (r.kind === 'deleting' && r.board) onBoard(r.board);
  else return false;
  return true;
}

function ChangePassword({ code, onBoard, onLost }) {
  const { toast } = useTopbar();
  const askName = useAskName();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState({});
  const [phase, setPhase] = useState('entering'); // entering | confirming | saving | limited
  const [retryAfter, setRetryAfter] = useState(0);
  const [failed, setFailed] = useState(null);
  const [said, setSaid] = useState('');
  const currentRef = useRef(null);
  const toggleRef = useRef(null);
  const [selectCurrent, setSelectCurrent] = useState(false);
  const formId = useId();

  // After a wrong password, select it to retype once the fields are enabled again (they're disabled while saving).
  useEffect(() => {
    if (phase === 'entering' && selectCurrent) {
      currentRef.current?.select();
      setSelectCurrent(false);
    }
  }, [phase, selectCurrent]);
  // Too many tries: the fields are disabled, so focus goes to the notice that says why and for how long.
  const limitedRef = useRef(null);
  useEffect(() => {
    if (phase === 'limited') limitedRef.current?.focus({ preventScroll: true });
  }, [phase]);
  // Closing the form (Cancel, or a change that worked) removes what had focus: give it to the button that reopens it.
  const closeForm = () => {
    setOpen(false);
    requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
  };

  const reset = () => {
    setCurrent('');
    setNext('');
    setAgain('');
    setErrors({});
    setFailed(null);
  };

  const check = (e) => {
    e.preventDefault();
    if (phase !== 'entering') return;
    const found = {};
    if (!current) found.current = 'Type the password the board has now.';
    const pw = checkNewPassword(next);
    if (!pw.ok) found.next = pw.error;
    else if (next === current) found.next = 'That’s the password it has now. Choose a new one.';
    else if (again !== next) found.again = again ? "The two passwords don't match." : 'Type the new password again.';
    setErrors(found);
    setFailed(null);
    if (Object.keys(found).length === 0) setPhase('confirming');
  };

  const save = async () => {
    if (!(await askName(`change the password of ${code}`))) return setPhase('entering');
    setPhase('saving');
    const r = await changePassword(code, current, next);
    if (r.kind === 'open') {
      reset();
      closeForm();
      setPhase('entering');
      setSaid('Password changed.');
      toast('Password changed. This browser stays in; everyone else needs the new one.');
      return onBoard(r.board);
    }
    if (lost(r, { onBoard, onLost })) return undefined;
    if (r.kind === 'limited') {
      setCurrent('');
      setRetryAfter(r.retryAfter);
      return setPhase('limited');
    }
    setPhase('entering');
    if (r.kind === 'wrong') {
      setErrors({ current: "That password didn't work. Too many wrong tries pause this for a few minutes." });
      setSelectCurrent(true);
    } else if (r.kind === 'invalid') {
      setErrors({ [r.field === 'current' ? 'current' : 'next']: r.error });
    } else {
      setFailed(r.kind !== 'error' ? 'refused' : r.offline ? 'offline' : 'error');
    }
    return undefined;
  };

  const limited = phase === 'limited';
  const busy = phase === 'saving';

  return (
    <>
      <div className="pw-state">
        <span className="icon-circle icon-circle-row ic-accent">
          <LockIcon size={18} />
        </span>
        <span className="pw-state-text">
          <span className="pw-state-title">Password is on</span>
          <span className="pw-state-sub">Anyone opening this board needs it. It applies to everyone, not just this browser.</span>
        </span>
        {!open && (
          <button ref={toggleRef} type="button" className="btn btn-quiet" aria-expanded="false" aria-controls={formId} onClick={() => setOpen(true)}>
            Change password
          </button>
        )}
      </div>
      <p className="sr-only" role="status">
        {said}
      </p>

      {open && (
        <form id={formId} className="pw-form" onSubmit={check} aria-label="Change password" noValidate>
          {limited && (
            <div ref={limitedRef} tabIndex={-1} className="st-warn settings-limited" role="alert">
              <span className="icon-circle icon-circle-sm ic-warn">
                <WarningIcon />
              </span>
              <span className="pw-state-title">Too many tries for now</span>
              <span className="pw-state-sub">
                Your network has entered a wrong password too many times, here or on a lock screen. The board itself
                still works.
              </span>
              <Countdown retryAfter={retryAfter} onDone={() => setPhase('entering')} />
            </div>
          )}
          <div className="pw-fields" style={limited ? { opacity: 0.5 } : undefined}>
            <PasswordField
              label="Current password"
              value={current}
              onChange={(v) => {
                setCurrent(v);
                setErrors((x) => ({ ...x, current: undefined }));
              }}
              error={errors.current}
              hint={errors.current ? undefined : 'The one it has now. Nobody can recover a forgotten password.'}
              placeholder={limited ? 'Paused' : undefined}
              disabled={limited || busy}
              autoFocus
              inputRef={currentRef}
            />
            <PasswordField
              label="New password"
              value={next}
              onChange={(v) => {
                setNext(v);
                setErrors((x) => ({ ...x, next: undefined }));
              }}
              error={errors.next}
              hint={errors.next ? undefined : '8 to 128 characters.'}
              placeholder="New password"
              autoComplete="new-password"
              disabled={limited || busy}
            />
            <PasswordField
              label="Type it again"
              value={again}
              onChange={(v) => {
                setAgain(v);
                setErrors((x) => ({ ...x, again: undefined }));
              }}
              error={errors.again}
              placeholder="Same password"
              autoComplete="new-password"
              disabled={limited || busy}
            />
          </div>
          {failed && (
            <p className="banner banner-err" role="alert">
              <WarningIcon />
              <span className="banner-text">
                {failed === 'refused' ? (
                  <>
                    <b>That didn’t work.</b> The password hasn’t changed. Reload the page to see the board as it is now.
                  </>
                ) : (
                  <>
                    <b>{failed === 'offline' ? 'You’re offline.' : 'Couldn’t reach Next Up.'}</b> The password hasn’t
                    changed. Check your connection, then try again.
                  </>
                )}
              </span>
            </p>
          )}
          <div className="pw-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                reset();
                closeForm();
                if (!limited) setPhase('entering');
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={limited || (!current && !next && !again)} aria-disabled={busy || undefined}>
              {busy ? (
                <>
                  <span className="spin" aria-hidden="true" />
                  Changing…
                </>
              ) : (
                'Change password'
              )}
            </button>
          </div>
        </form>
      )}

      {phase === 'confirming' && <ConfirmChange code={code} onConfirm={save} onClose={() => setPhase('entering')} />}
    </>
  );
}

// design/v1 Settings "change: confirmation". Shown before anything is sent; the current password is checked when
// it is (one try, not two).
function ConfirmChange({ code, onConfirm, onClose }) {
  const titleId = useId();
  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={onClose}>
      <div className="modal-body">
        <span className="icon-circle icon-circle-sm ic-warn">
          <WarningIcon />
        </span>
        <h2 id={titleId} className="display modal-title">
          Change the password?
        </h2>
        <p className="modal-text">
          Everyone else will need the new password for <span className="code-text">{code}</span>. Anyone who has it open
          now gets the lock screen straight away, and so does every browser that saved the old one. This browser stays in.
        </p>
        <p className="modal-note">Tell the guild the new one before you go. Nobody can recover a forgotten password.</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Change password
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function DeleteRow({ code, onBoard, onLost }) {
  const navigate = useNavigate();
  const { toast } = useTopbar();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div className="pw-state">
        <span className="icon-circle icon-circle-row ic-err">
          <TrashIcon size={18} />
        </span>
        <span className="pw-state-text">
          <span className="pw-state-title">Delete board</span>
          <span className="pw-state-sub">
            Erased for good 24 hours after you delete it. Until then, anyone who can open it can restore it.
          </span>
        </span>
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
          Delete board
        </button>
      </div>
      {confirming && (
        <DeleteBoard
          code={code}
          onClose={() => setConfirming(false)}
          onDone={(r) => {
            setConfirming(false);
            if (r.kind === 'open' || (r.kind === 'deleting' && r.board)) {
              onBoard(r.board);
              toast(`${code} will be deleted in 24 hours. You can restore it from the board until then.`);
              navigate(`/b/${code}`);
              return;
            }
            lost(r, { onBoard, onLost });
          }}
        />
      )}
    </>
  );
}

function Deleting({ code, deletion, onBoard, onLost }) {
  const { toast } = useTopbar();
  const [restoring, setRestoring] = useState(false);
  const left = useTimeLeft(deletion.deadline, () => setTimeout(() => onLost({ kind: 'none' }), 1500));
  return (
    <>
      <div className="st-warn settings-deleting" role="status">
        <span className="icon-circle icon-circle-sm ic-warn">
          <TrashIcon size={20} />
        </span>
        <span className="pw-state-title">
          {left > 0 ? (
            <>
              This board will be deleted in <span className="deleting-left">{formatLeft(left)}</span>.
            </>
          ) : (
            'This board is being deleted now.'
          )}
        </span>
        <span className="pw-state-sub">
          Until then nothing on it can change, its password included. Anyone who can open it can restore it.
        </span>
        {left > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setRestoring(true)}>
            <RestoreIcon />
            Restore board
          </button>
        )}
      </div>
      {restoring && (
        <RestoreBoard
          code={code}
          onClose={() => setRestoring(false)}
          onDone={(r) => {
            setRestoring(false);
            if (r.kind === 'open' || r.kind === 'not-deleting') {
              onBoard(r.board);
              toast(r.kind === 'open' ? `Restored. ${code} won’t be deleted.` : `Someone else restored ${code} first.`);
              return;
            }
            lost(r, { onBoard, onLost });
          }}
        />
      )}
    </>
  );
}
