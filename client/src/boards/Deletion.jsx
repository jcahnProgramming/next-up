import { useEffect, useId, useRef, useState } from 'react';
import { ErrorIcon, RestoreIcon, TrashIcon, WarningIcon } from '../chrome/icons.jsx';
import { Overlay } from '../chrome/Overlay.jsx';
import { useAskName } from '../prefs/NamePrompt.jsx';
import { deleteBoard, restoreBoard } from './api.js';
import { normalizeCode } from './codes.js';

/**
 * Deleting a board, and restoring it in the 24 hours before it's erased (server/boards/retire.js).
 *
 * The board's API says `deletion: { scheduledAt, purgeAt, leftMs }` while it's being deleted. `leftMs` is the
 * server's own count at the moment it answered, so the countdown runs from that (withDeadline) and never from this
 * device's clock against purgeAt: a phone set five minutes fast still shows the time Next Up will actually act.
 *
 *   <DeletingBanner>   on the board: "This board will be deleted in 23h 12m." with Restore
 *   <RestoreBoard>     the confirmation Restore opens (Settings uses it too)
 *   <DeleteBoard>      Settings' confirmation: type the code to delete
 */

/** The deletion with `deadline`: this device's Date.now() when it reaches zero, measured from the server's leftMs. */
export function withDeadline(deletion) {
  if (!deletion) return null;
  return { ...deletion, deadline: Date.now() + Math.max(0, Number(deletion.leftMs) || 0) };
}

/** Milliseconds left until `deadline`, ticking once a second; onDone() once, at zero. */
export function useTimeLeft(deadline, onDone) {
  const [left, setLeft] = useState(() => (deadline ? Math.max(0, deadline - Date.now()) : 0));
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!deadline) return undefined;
    let fired = false;
    const tick = () => {
      const ms = Math.max(0, deadline - Date.now());
      setLeft(ms);
      if (ms === 0 && !fired) {
        fired = true;
        clearInterval(timer);
        done.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [deadline]);
  return left;
}

/** 83_520_000 → "23h 12m"; 2_460_000 → "41m"; under a minute → "less than a minute". */
export function formatLeft(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const whenOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/**
 * The board's banner while it's being deleted: the live countdown, that editing is paused, and Restore. At zero it
 * says the board is being deleted now (onDone: the page looks the code up again, and finds it free).
 */
export function DeletingBanner({ deletion, canRestore, onRestore, onDone }) {
  const left = useTimeLeft(deletion.deadline, onDone);
  return (
    <div className="banner banner-warn board-banner deleting-banner" role="status">
      <TrashIcon size={18} />
      <span className="banner-text">
        {left > 0 ? (
          <>
            <b>
              This board will be deleted in <span className="deleting-left">{formatLeft(left)}</span>.
            </b>{' '}
            Editing is paused. Anyone who can open it can restore it until {whenOf(deletion.purgeAt)}.
          </>
        ) : (
          <>
            <b>This board is being deleted now.</b> Its cards, players and history are being erased.
          </>
        )}
      </span>
      {left > 0 && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRestore} disabled={!canRestore}>
          <RestoreIcon />
          Restore
        </button>
      )}
    </div>
  );
}

/**
 * "Restore <code>?": one click plus this confirmation. Asks the display name first, like any change.
 * onDone(result): open (restored: board without deletion) · not-deleting (someone restored it first) · locked · free.
 */
export function RestoreBoard({ code, onClose, onDone }) {
  const titleId = useId();
  const askName = useAskName();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const confirm = async () => {
    if (busy) return;
    if (!(await askName(`restore ${code}`))) return;
    setFailed(null);
    setBusy(true);
    const r = await restoreBoard(code);
    setBusy(false);
    if (r.kind === 'error') return setFailed(r.offline ? 'offline' : 'error');
    onDone(r);
  };

  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={busy ? undefined : onClose}>
      <div className="modal-body">
        <span className="icon-circle icon-circle-sm ic-accent">
          <RestoreIcon size={22} />
        </span>
        <h2 id={titleId} className="display modal-title">
          Restore <span className="code-text">{code}</span>?
        </h2>
        <p className="modal-text">
          It goes back to normal for everyone who can open it: it won’t be deleted, and editing works again. History
          keeps a note that you restored it.
        </p>
        {failed && <Failed offline={failed === 'offline'} what="Nothing was restored" />}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={busy || undefined}>
            {busy ? (
              <>
                <span className="spin" aria-hidden="true" />
                Restoring…
              </>
            ) : (
              'Restore board'
            )}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * "Delete <code>?": type the code to confirm. The copy says what happens now, for 24 hours, and after.
 * onDone(result): open (board with deletion) · deleting (already being deleted: board) · locked · free.
 */
export function DeleteBoard({ code, onClose, onDone }) {
  const titleId = useId();
  const fieldId = useId();
  const askName = useAskName();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [error, setError] = useState(null);
  const matches = normalizeCode(typed) === code;

  const confirm = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!matches) return setError(typed ? 'That isn’t this board’s code.' : 'Type the board’s code to confirm.');
    if (!(await askName(`delete ${code}`))) return undefined;
    setFailed(null);
    setBusy(true);
    const r = await deleteBoard(code, typed);
    setBusy(false);
    if (r.kind === 'error') return setFailed(r.offline ? 'offline' : 'error');
    if (r.kind === 'invalid') return setError(r.error);
    return onDone(r);
  };

  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={busy ? undefined : onClose}>
      <form className="modal-body" onSubmit={confirm} noValidate>
        <span className="icon-circle icon-circle-sm ic-err">
          <TrashIcon size={22} />
        </span>
        <h2 id={titleId} className="display modal-title">
          Delete <span className="code-text">{code}</span>?
        </h2>
        <div className="modal-text delete-board-text">
          <p>
            <b>For the next 24 hours</b> the board stays where it is, with a countdown for everyone who opens it, and
            nobody can change it. Anyone who can open it can restore it in that time, with one click.
          </p>
          <p>
            <b>After 24 hours</b> it’s erased for good: every card, player and line of history. Nobody can bring it back,
            and <span className="code-text">{code}</span> is free for anyone to make a new board with.
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={fieldId}>
            Type <span className="code-text">{code}</span> to confirm
          </label>
          <input
            id={fieldId}
            className="field-input field-mono"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? `${fieldId}-err` : undefined}
            data-autofocus
          />
          {error && (
            <span id={`${fieldId}-err`} className="field-error" role="alert">
              <ErrorIcon />
              {error}
            </span>
          )}
        </div>
        {failed && <Failed offline={failed === 'offline'} what="Nothing was deleted" />}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>
            Keep the board
          </button>
          <button type="submit" className="btn btn-danger" disabled={!matches && !busy} aria-disabled={busy || undefined}>
            {busy ? (
              <>
                <span className="spin" aria-hidden="true" />
                Deleting…
              </>
            ) : (
              <>
                <TrashIcon />
                Delete board
              </>
            )}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

function Failed({ offline, what }) {
  return (
    <p className="banner banner-err" role="alert">
      <WarningIcon />
      <span className="banner-text">
        <b>{offline ? 'You’re offline.' : 'Couldn’t reach Next Up.'}</b> {what}. Check your connection, then try again.
      </span>
    </p>
  );
}
