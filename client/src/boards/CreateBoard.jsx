import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { PlusIcon, WarningIcon } from '../chrome/icons.jsx';
import { createBoard } from './api.js';
import { checkNewPassword } from './codes.js';
import { PasswordField } from './PasswordField.jsx';

/**
 * "<code> is free: create it?" (design/v1 Landing-States 3; a bottom sheet on a phone, Landing-Phone).
 *
 * The password is a one-way choice made here and only here: a board created without one stays open for good, and a
 * password, once set, can be changed later but never removed. The copy says both, whichever way the field is.
 *
 * sheetOnPhone: at phone width, slide up as a bottom sheet over the page (rendered on <body>: inside a glass sheet a
 * fixed, blurred layer can neither escape nor blur what's behind it).
 *
 * Reports the outcome upward: onCreated(board) | onLimited(retryAfter) | onFull() | onTaken(); onBack() leaves.
 */
export function CreateBoard({ code, heading: H = 'h2', sheetOnPhone = false, onBack, onCreated, onLimited, onFull, onTaken }) {
  const titleId = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const withPassword = password.length > 0;
  const asSheet = usePhone() && sheetOnPhone;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [busy, onBack]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const next = {};
    if (withPassword) {
      const pw = checkNewPassword(password);
      if (!pw.ok) next.password = pw.error;
      else if (confirm !== password) next.confirm = confirm ? "The two passwords don't match." : 'Type the password again.';
    }
    setErrors(next);
    setFailed(null);
    if (Object.keys(next).length) return;

    setBusy(true);
    const result = await createBoard(code, withPassword ? password : '');
    setBusy(false);
    if (result.kind === 'open') return onCreated(result.board);
    if (result.kind === 'limited') return onLimited(result.retryAfter);
    if (result.kind === 'full') return onFull();
    if (result.kind === 'exists') return onTaken();
    if (result.kind === 'invalid' && result.field === 'password') return setErrors({ password: result.error });
    setFailed(result.offline ? 'offline' : 'error');
  };

  const panel = (
    <div className={`create${asSheet ? ' is-sheet' : ''}`}>
      <div className="create-scrim" aria-hidden="true" onClick={busy ? undefined : onBack} />
      <form className="create-sheet glass-2" onSubmit={submit} role="dialog" aria-labelledby={titleId} noValidate>
        <span className="create-grabber" aria-hidden="true" />
        <div className="create-head">
          <span className="icon-circle icon-circle-sm ic-accent">
            <PlusIcon />
          </span>
          <div className="create-head-text">
            <H id={titleId} className="display create-title">
              <span className="code-text">{code}</span> is free
            </H>
            <span className="create-sub">Nobody has made this board yet. Create it?</span>
          </div>
        </div>

        <PasswordField
          label="Board password"
          optional
          value={password}
          onChange={(v) => {
            setPassword(v);
            setErrors({});
          }}
          error={errors.password}
          placeholder="Leave empty for an open board"
          autoComplete="new-password"
          autoFocus
          disabled={busy}
        />
        {withPassword && (
          <PasswordField
            label="Type it again"
            value={confirm}
            onChange={(v) => {
              setConfirm(v);
              setErrors((x) => ({ ...x, confirm: undefined }));
            }}
            error={errors.confirm}
            placeholder="Same password"
            autoComplete="new-password"
            disabled={busy}
          />
        )}

        <div className="create-choice" aria-live="polite">
          {withPassword ? (
            <p>
              <b>Locked, for good.</b> Anyone with the code sees only a lock screen until they enter this password. You’ll
              be able to change it later in Settings (coming soon), but never remove it. Nobody can recover a forgotten
              password, so keep it somewhere safe.
            </p>
          ) : (
            <p>
              <b>Open, for good.</b> Anyone with the code can open and edit this board. A password can only be set now,
              while you create it: an open board can never get one later.
            </p>
          )}
        </div>

        {failed && (
          <p className="banner banner-err" role="alert">
            <WarningIcon />
            <span className="banner-text">
              <b>{failed === 'offline' ? "You're offline." : "Couldn't reach Next Up."}</b> Nothing was created. Check
              your connection, then try again.
            </span>
          </p>
        )}

        <div className="create-actions">
          <button type="button" className="btn btn-quiet" onClick={onBack} disabled={busy}>
            Back
          </button>
          <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined}>
            {busy ? (
              <>
                <span className="spin" aria-hidden="true" />
                Creating…
              </>
            ) : withPassword ? (
              'Create locked board'
            ) : (
              'Create open board'
            )}
          </button>
        </div>
      </form>
    </div>
  );
  return asSheet ? createPortal(panel, document.body) : panel;
}

const PHONE = '(max-width: 600px)';
function usePhone() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(PHONE);
      mq.addEventListener('change', onChange);
      return () => {
        mq.removeEventListener('change', onChange);
      };
    },
    () => window.matchMedia(PHONE).matches,
  );
}
