import { useId, useState } from 'react';
import { DatePicker } from '../chrome/DatePicker.jsx';
import { Dropdown } from '../chrome/Dropdown.jsx';
import { CloseIcon, EditIcon, ErrorIcon, HistoryIcon, TrashIcon, WarningIcon } from '../chrome/icons.jsx';
import { Overlay } from '../chrome/Overlay.jsx';
import { usePhone } from '../chrome/usePhone.js';
import { SERVER_INFO_MAX, checkServerInfo, cleanServerInfo } from '../../../server/core/cardDetail.js';
import { LANES, TITLE_MAX, checkTitle, cleanTitle, laneName } from '../../../server/core/cardRules.js';
import { CardFace } from './Card.jsx';
import { GoLive, Players, ServerInfo } from './CardDetail.jsx';
import { LogoPicker } from './LogoPicker.jsx';
import { LOGOS } from './logos.js';
import { PausedBanner } from '../live/Live.jsx';

/**
 * The sheets a card opens (design/v1 Detail-Desktop, Detail-Edit, Detail-Phone; a side sheet on a desktop, a bottom
 * sheet on a phone):
 *
 *   CardPanel      the card: its header pill and lane, go-live date, server info and sign-ups (CardDetail.jsx);
 *                  Edit, Delete and This card's history. Players are added and removed right here, with no edit
 *                  mode.
 *   CardEditor     add or edit: game name, logo, lane, go-live date (the themed DatePicker) and server info
 *   ConfirmDelete  "Delete Valheim?"
 *
 * Live sync: the panel shows the card as it is now, updating in place; if someone else deletes it (`goneBy`), the
 * panel says so instead of its details. The edit sheet keeps what's being typed when someone else changes the card:
 * it says "Changed by …" with Load their changes, and saving still names the version it started from, so the
 * server's conflict check catches it rather than overwriting.
 */

export function CardPanel({ code, card, goneBy = null, paused, toast, onEdit, onDelete, onHistory, onClose, onCount, onLocked, onGone }) {
  const titleId = useId();
  const gone = goneBy !== null;
  return (
    <Overlay kind="side" labelledBy={titleId} onClose={onClose} className="card-panel">
      <div className="panel-hero">
        <CardFace card={card} header titleAs="h2" titleId={titleId}>
          <span className="card-chips">
            <span className="card-chip">
              <span className={`lane-dot ld-${card.lane}`} aria-hidden="true" />
              {laneName(card.lane)}
            </span>
          </span>
        </CardFace>
        <div className="panel-hero-actions">
          <button type="button" className="btn btn-sm hero-btn" onClick={() => onEdit()} disabled={paused || gone}>
            <EditIcon />
            Edit
          </button>
          <button type="button" className="icon-btn hero-btn" onClick={onClose} aria-label="Close" title="Close">
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="sheet-body card-detail">
        {gone ? (
          <div className="sheet-gone">
            <div className="banner banner-warn" role="alert">
              <WarningIcon />
              <span className="banner-text">
                <b>{goneBy} deleted this card.</b> It’s off the board for everyone. History can bring it back.
              </span>
            </div>
          </div>
        ) : (
          <>
            {paused && <PausedBanner />}
            <GoLive value={card.goLive} paused={paused} onSet={() => onEdit('goLive')} />
            <ServerInfo value={card.serverInfo} paused={paused} onSet={() => onEdit('serverInfo')} toast={toast} />
            <Players key={card.id} code={code} card={card} paused={paused} onCount={onCount} onLocked={onLocked} onGone={onGone} />
          </>
        )}
      </div>

      <div className="sheet-foot">
        <span className="sheet-foot-note">
          Added <time dateTime={card.createdAt}>{formatInstant(card.createdAt)}</time>
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onHistory}>
          <HistoryIcon size={14} />
          This card’s history
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-delete" onClick={onDelete} disabled={paused || gone}>
          <TrashIcon />
          Delete card
        </button>
      </div>
    </Overlay>
  );
}

export function CardEditor({ card, changedBy = null, goneBy = null, lane: startLane, focus, paused, full, onSave, onDelete, onClose }) {
  const titleId = useId();
  const nameId = useId();
  const logoId = useId();
  const laneId = useId();
  const dateId = useId();
  const infoId = useId();
  const phone = usePhone();
  const adding = !card;
  const [title, setTitle] = useState(card?.title ?? '');
  const [logo, setLogo] = useState(card?.logo ?? null);
  const [lane, setLane] = useState(card?.lane ?? startLane ?? 'up_next');
  const [goLive, setGoLive] = useState(card?.goLive ?? null);
  const [serverInfo, setServerInfo] = useState(card?.serverInfo ?? '');
  const [titleError, setTitleError] = useState(null);
  const [infoError, setInfoError] = useState(null);
  const [failure, setFailure] = useState(null); // { kind: 'offline' | 'error' | 'full' | 'conflict', text? }
  const [busy, setBusy] = useState(false);
  // The card as this sheet last loaded it: what the fields started from, and the version a save is an edit of.
  const [base, setBase] = useState(card);
  const changed = !adding && card && base && card.version !== base.version;
  const gone = goneBy !== null;

  // Someone else's newer version, put in the fields (the person chose to, or it's what a conflict showed them).
  const adopt = (c) => {
    setTitle(c.title);
    setLogo(c.logo);
    setLane(c.lane);
    setGoLive(c.goLive);
    setServerInfo(c.serverInfo);
    setTitleError(null);
    setInfoError(null);
    setBase(c);
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (busy || gone) return;
    const t = checkTitle(title);
    if (!t.ok) {
      setTitleError(t.error);
      return;
    }
    setTitleError(null);
    const info = checkServerInfo(serverInfo);
    if (!info.ok) {
      setInfoError(info.error);
      return;
    }
    setInfoError(null);
    let values = { title: t.title, logo, lane, goLive, serverInfo: info.serverInfo };
    if (!adding) {
      values = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== base[k]));
      if (Object.keys(values).length === 0) return onClose();
    }
    setFailure(null);
    setBusy(true);
    const r = await onSave(values, base);
    setBusy(false);
    if (r.kind === 'invalid') {
      if (r.field === 'title') setTitleError(r.error);
      else if (r.field === 'serverInfo') setInfoError(r.error);
      else setFailure({ kind: 'refused', text: r.error });
    } else if (r.kind === 'conflict') {
      // Show what's there now; the person makes their change again on top of it.
      adopt(r.card);
      setFailure({ kind: 'conflict' });
    } else if (r.kind === 'full') {
      setFailure({ kind: 'full', text: r.error });
    } else if (r.kind === 'error') {
      setFailure({ kind: r.offline ? 'offline' : 'error' });
    }
  };

  const heading = adding ? 'Add a game' : 'Edit card';
  const cancel = (
    <button type="button" className="btn btn-quiet btn-sm" onClick={onClose} disabled={busy}>
      Cancel
    </button>
  );
  const saveButton = (
    <button type="submit" className="btn btn-primary btn-sm" aria-disabled={busy || undefined} disabled={(adding && full) || gone}>
      {busy ? (
        <>
          <span className="spin" aria-hidden="true" />
          Saving…
        </>
      ) : adding ? (
        'Add'
      ) : (
        'Save'
      )}
    </button>
  );

  return (
    <Overlay kind="side" labelledBy={titleId} onClose={busy ? undefined : onClose} className="card-editor">
      <form className="sheet-form" onSubmit={submit} noValidate>
        <div className="sheet-head is-ruled">
          {phone && cancel}
          <h2 id={titleId} className="display sheet-title">
            {heading}
          </h2>
          {!phone && cancel}
          {saveButton}
        </div>

        <div className="sheet-body">
          {gone ? (
            <div className="banner banner-warn" role="alert">
              <WarningIcon />
              <span className="banner-text">
                <b>{goneBy} deleted this card,</b> so these changes can’t be saved. History can bring it back.
              </span>
            </div>
          ) : failure ? (
            <Failure failure={failure} onRetry={submit} />
          ) : (
            paused && <PausedBanner />
          )}
          {changed && !gone && (
            <div className="banner banner-info" role="status">
              <span className="banner-text">
                <b>Changed by {changedBy ?? 'someone else'}.</b> What you’ve typed is kept; saving checks it against
                their version first.
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
                adopt(card);
                setFailure(null);
              }}>
                Load their changes
              </button>
            </div>
          )}
          {adding && full && !failure && (
            <p className="banner banner-info" role="status">
              <span className="banner-text">
                <b>This board is full.</b> Delete a game to add another.
              </span>
            </p>
          )}

          <div className="field">
            <label className="field-label" htmlFor={nameId}>
              Game
            </label>
            <input
              id={nameId}
              className="field-input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleError(null);
              }}
              maxLength={TITLE_MAX * 2}
              placeholder="e.g. Valheim"
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={titleError ? 'true' : undefined}
              aria-describedby={titleError ? `${nameId}-error` : undefined}
              data-autofocus={!focus || undefined}
            />
            {titleError ? (
              <span id={`${nameId}-error`} className="field-error" role="alert">
                <ErrorIcon />
                {titleError}
              </span>
            ) : (
              [...cleanTitle(title)].length > TITLE_MAX - 10 && (
                <span className="field-hint">
                  {[...cleanTitle(title)].length} of {TITLE_MAX} characters
                </span>
              )
            )}
          </div>

          <div className="field">
            <span className="field-label" id={logoId}>
              Logo
            </span>
            <LogoPicker
              labelledBy={logoId}
              value={logo}
              title={cleanTitle(title)}
              onChange={(id, picked) => {
                setLogo(id);
                if (picked && !cleanTitle(title)) {
                  setTitle(picked.name);
                  setTitleError(null);
                }
              }}
            />
            <span className="field-hint">
              {LOGOS.length > 0
                ? 'From Next Up’s logo library. Type to search when open.'
                : 'Next Up’s logo library is empty for now, so cards use a solid colour.'}
            </span>
          </div>

          <div className="field-grid">
            <div className="field">
              <span className="field-label" id={laneId}>
                Lane
              </span>
              <Dropdown
                labelledBy={laneId}
                value={lane}
                onChange={setLane}
                options={LANES.map((l) => ({ value: l.id, label: l.name, icon: <span className={`lane-dot ld-${l.id}`} aria-hidden="true" /> }))}
              />
              {!adding && lane !== base.lane && <span className="field-hint">It goes to the bottom of {laneName(lane)}.</span>}
            </div>
            <div className="field">
              <span className="field-label" id={dateId}>
                Go-live date
              </span>
              <DatePicker labelledBy={dateId} value={goLive} onChange={setGoLive} autoFocus={focus === 'goLive'} />
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor={infoId}>
              Server info
            </label>
            <textarea
              id={infoId}
              className="field-input field-textarea"
              value={serverInfo}
              onChange={(e) => {
                setServerInfo(e.target.value);
                setInfoError(null);
              }}
              rows={6}
              placeholder="IP, port, password, links…"
              spellCheck="false"
              aria-invalid={infoError ? 'true' : undefined}
              aria-describedby={`${infoId}-hint`}
              data-autofocus={focus === 'serverInfo' || undefined}
            />
            {infoError ? (
              <span id={`${infoId}-hint`} className="field-error" role="alert">
                <ErrorIcon />
                {infoError}
              </span>
            ) : (
              <span id={`${infoId}-hint`} className="field-hint">
                Free text. Links become clickable. Anyone who can open this board can see it.
                {infoLength(serverInfo) > SERVER_INFO_MAX - 200 && ` ${infoLength(serverInfo).toLocaleString()} of ${SERVER_INFO_MAX.toLocaleString()} characters.`}
              </span>
            )}
          </div>
        </div>

        {!adding && (
          <div className="sheet-foot">
            <button type="button" className="btn btn-danger btn-sm" onClick={onDelete} disabled={busy || gone || paused}>
              <TrashIcon />
              Delete card
            </button>
            <span className="sheet-foot-note">Deleted cards are kept, so History can restore them.</span>
          </div>
        )}
      </form>
    </Overlay>
  );
}

export function ConfirmDelete({ card, paused, onDelete, onClose }) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  const confirm = async () => {
    if (busy) return;
    setFailure(null);
    setBusy(true);
    const r = await onDelete();
    setBusy(false);
    if (r.kind === 'conflict') setFailure({ kind: 'conflict-delete' });
    else if (r.kind === 'error') setFailure({ kind: r.offline ? 'offline' : 'error' });
  };

  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={busy ? undefined : onClose}>
      <div className="modal-body">
        <h2 id={titleId} className="display modal-title">
          Delete {card.title}?
        </h2>
        <p className="modal-text">
          It comes off the board for everyone with the code. Next Up keeps deleted cards, so History can restore it.
        </p>
        {failure ? <Failure failure={failure} onRetry={confirm} /> : paused && <PausedBanner />}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={confirm} aria-disabled={busy || undefined}>
            {busy ? (
              <>
                <span className="spin" aria-hidden="true" />
                Deleting…
              </>
            ) : (
              <>
                <TrashIcon />
                Delete card
              </>
            )}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function Failure({ failure, onRetry }) {
  if (failure.kind === 'offline') return <PausedBanner />;
  const text = {
    error: (
      <>
        <b>Couldn’t reach Next Up.</b> Nothing was saved. Check your connection, then try again.
      </>
    ),
    refused: (
      <>
        <b>Not saved.</b> {failure.text}
      </>
    ),
    full: (
      <>
        <b>This board is full.</b> {failure.text}
      </>
    ),
    conflict: (
      <>
        <b>Someone else changed this card first.</b> This shows their version now; make your change again and save.
      </>
    ),
    'conflict-delete': (
      <>
        <b>Someone else changed this card a moment ago.</b> Check it’s the one you mean, then delete again.
      </>
    ),
  }[failure.kind];
  const retry = failure.kind === 'error';
  return (
    <div className={`banner ${failure.kind === 'error' ? 'banner-err' : 'banner-warn'}`} role="alert">
      <WarningIcon />
      <span className="banner-text">{text}</span>
      {retry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

const infoLength = (value) => [...cleanServerInfo(value)].length;

const formatInstant = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};
