import { useId, useState } from 'react';
import { Dropdown } from '../chrome/Dropdown.jsx';
import { CloseIcon, EditIcon, ErrorIcon, TrashIcon, WarningIcon } from '../chrome/icons.jsx';
import { Overlay } from '../chrome/Overlay.jsx';
import { usePhone } from '../chrome/usePhone.js';
import { LANES, TITLE_MAX, checkTitle, cleanTitle, laneName } from '../../../server/core/cardRules.js';
import { CardFace } from './Card.jsx';
import { LogoPicker } from './LogoPicker.jsx';
import { LOGOS, logoById } from './logos.js';

/**
 * The sheets a card opens (design/v1 Detail-Desktop, Detail-Edit, Detail-Phone; a side sheet on a desktop, a bottom
 * sheet on a phone):
 *
 *   CardPanel      the card: its header pill, lane, logo, when it was added; Edit and Delete
 *   CardEditor     add or edit: game name, logo, lane
 *   ConfirmDelete  "Delete Valheim?"
 *
 * Go-live date, server info and sign-ups join the panel and editor when they're built; until then they're left out,
 * not shown empty.
 */

export function CardPanel({ card, paused, onEdit, onDelete, onClose }) {
  const titleId = useId();
  const logo = logoById(card.logo);
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
          <button type="button" className="btn btn-sm hero-btn" onClick={onEdit} disabled={paused}>
            <EditIcon />
            Edit
          </button>
          <button type="button" className="icon-btn hero-btn" onClick={onClose} aria-label="Close" title="Close">
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="sheet-body">
        {paused && <PausedBanner />}
        <dl className="card-facts">
          <div>
            <dt>Lane</dt>
            <dd>
              <span className={`lane-dot ld-${card.lane}`} aria-hidden="true" />
              {laneName(card.lane)}
            </dd>
          </div>
          <div>
            <dt>Logo</dt>
            <dd>{logo ? logo.name : card.logo ? 'No logo (its file is no longer in the library)' : 'No logo'}</dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd>
              <time dateTime={card.createdAt}>{formatDate(card.createdAt)}</time>
            </dd>
          </div>
          {card.updatedAt !== card.createdAt && (
            <div>
              <dt>Last changed</dt>
              <dd>
                <time dateTime={card.updatedAt}>{formatDate(card.updatedAt)}</time>
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="sheet-foot">
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm btn-delete" onClick={onDelete} disabled={paused}>
          <TrashIcon />
          Delete card
        </button>
      </div>
    </Overlay>
  );
}

export function CardEditor({ card, lane: startLane, paused, full, onSave, onDelete, onClose }) {
  const titleId = useId();
  const nameId = useId();
  const logoId = useId();
  const laneId = useId();
  const phone = usePhone();
  const adding = !card;
  const [title, setTitle] = useState(card?.title ?? '');
  const [logo, setLogo] = useState(card?.logo ?? null);
  const [lane, setLane] = useState(card?.lane ?? startLane ?? 'up_next');
  const [titleError, setTitleError] = useState(null);
  const [failure, setFailure] = useState(null); // { kind: 'offline' | 'error' | 'full' | 'conflict', text? }
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    const t = checkTitle(title);
    if (!t.ok) {
      setTitleError(t.error);
      return;
    }
    setTitleError(null);
    let values = { title: t.title, logo, lane };
    if (!adding) {
      values = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== card[k]));
      if (Object.keys(values).length === 0) return onClose();
    }
    setFailure(null);
    setBusy(true);
    const r = await onSave(values);
    setBusy(false);
    if (r.kind === 'invalid') {
      if (r.field === 'title') setTitleError(r.error);
      else setFailure({ kind: 'refused', text: r.error });
    } else if (r.kind === 'conflict') {
      // Show what's there now; the person makes their change again on top of it.
      setTitle(r.card.title);
      setLogo(r.card.logo);
      setLane(r.card.lane);
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
    <button type="submit" className="btn btn-primary btn-sm" aria-disabled={busy || undefined} disabled={adding && full}>
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
          {failure ? <Failure failure={failure} onRetry={submit} /> : paused && <PausedBanner onRetry={submit} />}
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
              data-autofocus
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
              {!adding && lane !== card.lane && <span className="field-hint">It goes to the bottom of {laneName(lane)}.</span>}
            </div>
          </div>
        </div>

        {!adding && (
          <div className="sheet-foot">
            <button type="button" className="btn btn-danger btn-sm" onClick={onDelete} disabled={busy}>
              <TrashIcon />
              Delete card
            </button>
            <span className="sheet-foot-note">Deleted cards are kept, so History can restore them once it’s built.</span>
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
          It comes off the board for everyone with the code. Next Up keeps deleted cards, so it can be restored once
          History is built.
        </p>
        {failure ? <Failure failure={failure} onRetry={confirm} /> : paused && <PausedBanner onRetry={confirm} />}
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

// "Editing paused until we reconnect." with a Retry, wherever editing is paused by being offline (CLAUDE.md).
function PausedBanner({ onRetry }) {
  return (
    <div className="banner banner-err" role="status">
      <WarningIcon />
      <span className="banner-text">
        <b>You’re offline.</b> Editing paused until we reconnect.
      </span>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function Failure({ failure, onRetry }) {
  if (failure.kind === 'offline') return <PausedBanner onRetry={onRetry} />;
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

const formatDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};
