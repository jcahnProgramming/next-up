import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CloseIcon, RestoreIcon, RetryIcon, WarningIcon } from '../chrome/icons.jsx';
import { Overlay } from '../chrome/Overlay.jsx';
import { usePhone } from '../chrome/usePhone.js';
import { PausedBanner, useLiveChanges, usePaused } from '../live/Live.jsx';
import { useAskName } from '../prefs/NamePrompt.jsx';
import { readDisplayName } from '../prefs/displayName.js';
import { laneName } from '../../../server/core/cardRules.js';
import { hueOf, initialsOf } from '../cards/CardDetail.jsx';
import { formatDate } from '../cards/dates.js';
import { logoById } from '../cards/logos.js';
import { loadHistory, previewRestore, restoreEvent } from './api.js';
import './history.css';

/**
 * History (design/v1 History): the board's changes, newest first, 50 at a time with "Load more". A side sheet on a
 * desktop, a bottom sheet on a phone. Each line is the server's (every event type declares how it reads), so nothing
 * here knows one kind of change from another. Opened from the top bar, or from a card ("This card's history") with
 * `cardId`, which can be widened to the whole board.
 *
 *   loading (shimmer rows) · couldn't load (error tint, Retry) · nothing yet (dashed, neutral) · the list
 *
 * Restore asks for this browser's display name first if it never has (a restore is a change), then shows what will
 * change (RestoreSheet) before doing anything. A change that has been restored says so, with no second Restore.
 *
 * New changes, anyone's, arrive live (live/) in History's own shape and go on top; a restore among them marks the
 * change it undid as restored. Ones that arrive while a page is loading are added once it has.
 */
export function HistoryPanel({ code, cardId: startCard = null, onClose, onRestored, onLocked }) {
  const titleId = useId();
  const paused = usePaused();
  const askName = useAskName();
  const now = useNow();
  const [cardId, setCardId] = useState(startCard);
  const [list, setList] = useState({ kind: 'loading' }); // loading | error{offline} | ready{events, next, card}
  const [more, setMore] = useState(null); // null | 'loading' | { error, offline }
  const [attempt, setAttempt] = useState(0);
  const [restoring, setRestoring] = useState(null); // the event being restored
  const latest = useRef({ onLocked });
  latest.current = { onLocked };

  const arrived = useRef(null); // live entries that came while the list was loading
  useEffect(() => {
    let live = true;
    setList({ kind: 'loading' });
    setMore(null);
    arrived.current = [];
    loadHistory(code, { cardId }).then((r) => {
      if (!live) return;
      const later = arrived.current ?? [];
      arrived.current = null;
      if (r.kind === 'ok') setList({ kind: 'ready', events: later.reduce(addEntry, r.events), next: r.next, card: r.card });
      else if (r.kind === 'locked') latest.current.onLocked(r.changed);
      else if (r.kind === 'gone') setCardId(null); // the card isn't on this board: show the whole board's history
      else setList({ kind: 'error', offline: r.offline });
    });
    return () => {
      live = false;
    };
  }, [code, cardId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useLiveChanges((m) => {
    if (m.reset) return reload();
    if (cardId !== null && m.entry.cardId !== cardId) return undefined;
    if (arrived.current) arrived.current.push(m.entry);
    else setList((l) => (l.kind === 'ready' ? { ...l, events: addEntry(l.events, m.entry) } : l));
    return undefined;
  });

  const loadMore = async () => {
    if (list.kind !== 'ready' || !list.next || more === 'loading') return;
    setMore('loading');
    const r = await loadHistory(code, { before: list.next, cardId });
    if (r.kind === 'ok') {
      setList((l) => ({ ...l, events: [...l.events, ...r.events.filter((e) => !l.events.some((x) => x.id === e.id))], next: r.next }));
      setMore(null);
    } else if (r.kind === 'locked') onLocked(r.changed);
    else setMore({ offline: r.kind === 'error' && r.offline });
  };

  const startRestore = async (event) => {
    if (!(await askName(`restore ${event.line.subject || 'this change'}`))) return;
    setRestoring(event);
  };

  const filtered = list.kind === 'ready' && list.card;
  return (
    <Overlay kind="side" labelledBy={titleId} onClose={onClose} className="history-panel">
      <div className="sheet-head is-ruled">
        <h2 id={titleId} className="display sheet-title">
          History
        </h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <CloseIcon />
        </button>
      </div>
      {filtered && (
        <div className="history-filter">
          <span className="history-filter-text">
            Only <b>{list.card.title}</b>
            {list.card.deleted ? ' (deleted)' : ''}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCardId(null)}>
            Show the whole board
          </button>
        </div>
      )}

      <div className="sheet-body history-body">
        {paused && <PausedBanner />}

        {list.kind === 'loading' && (
          <div className="h-loading" aria-busy="true" aria-label="Loading the history">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="h-sk">
                <span className="sk sk-av" />
                <span className="sk sk-line" />
              </span>
            ))}
          </div>
        )}

        {list.kind === 'error' && (
          <section className="st-error history-state" role="alert">
            <span className="icon-circle icon-circle-sm ic-err">
              <WarningIcon />
            </span>
            <h3 className="history-state-title">{list.offline ? 'You’re offline' : 'Couldn’t load the history'}</h3>
            <p className="history-state-text">
              {list.offline ? 'The history needs a connection.' : 'Next Up didn’t answer. Nothing on the board has changed; we just couldn’t fetch its history.'}
            </p>
            <button type="button" className="btn btn-primary btn-sm" onClick={reload}>
              <RetryIcon size={16} />
              Try again
            </button>
          </section>
        )}

        {list.kind === 'ready' && list.events.length === 0 && (
          <section className="st-empty history-state">
            <h3 className="history-state-title">No changes yet</h3>
            <p className="history-state-text">
              {filtered ? `Nothing has happened to ${list.card.title} yet.` : 'Changes to this board will show here.'}
            </p>
          </section>
        )}

        {list.kind === 'ready' && list.events.length > 0 && (
          <Days events={list.events} now={now} paused={paused} onRestore={startRestore} />
        )}

        {list.kind === 'ready' && list.next && (
          <div className="history-more">
            {more && more !== 'loading' && (
              <span className="field-error" role="alert">
                {more.offline ? 'You’re offline, so older changes didn’t load.' : 'Couldn’t load older changes.'}
              </span>
            )}
            <button type="button" className="btn btn-quiet btn-sm" onClick={loadMore} aria-disabled={more === 'loading' || undefined}>
              {more === 'loading' ? (
                <>
                  <span className="spin" aria-hidden="true" />
                  Loading…
                </>
              ) : more ? (
                'Try again'
              ) : (
                'Load more'
              )}
            </button>
          </div>
        )}
      </div>

      <div className="sheet-foot history-foot">
        <span className="sheet-foot-note">Names are typed by each browser and aren’t verified. Nothing is ever removed from this list.</span>
      </div>

      {restoring && (
        <RestoreSheet
          code={code}
          event={restoring}
          now={now}
          onClose={() => setRestoring(null)}
          onLocked={onLocked}
          onDone={(r) => {
            setRestoring(null);
            reload();
            onRestored(r);
          }}
          onStale={() => {
            setRestoring(null);
            reload();
          }}
        />
      )}
    </Overlay>
  );
}

/**
 * A live entry put on top of the list (newest first), once. If it's a restore, the change it undid (when it's in the
 * list) now says who restored it, and offers no second Restore.
 */
function addEntry(events, entry) {
  if (events.some((e) => e.id === entry.id)) return events;
  const undone = entry.restores?.id;
  const marked = undone
    ? events.map((e) => (e.id === undone ? { ...e, restorable: false, restoredBy: { id: entry.id, actor: entry.actor, at: entry.at } } : e))
    : events;
  return [entry, ...marked];
}

/** The list, grouped under Today / Yesterday / the date. */
function Days({ events, now, paused, onRestore }) {
  const groups = [];
  for (const e of events) {
    const day = dayLabel(e.at, now);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  return (
    <div className="h-list">
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day}>
          <h3 className="h-day">{g.day}</h3>
          <ol className="h-rows">
            {g.items.map((e) => (
              <Row key={e.id} event={e} now={now} paused={paused} onRestore={onRestore} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Row({ event: e, now, paused, onRestore }) {
  const phone = usePhone();
  const someone = e.actor === 'Someone';
  return (
    <li className={`h-row${e.restoredBy ? ' is-restored' : ''}`}>
      <span className={`av ${someone ? 'av-someone' : hueOf(e.actor)}`} aria-hidden="true">
        {someone ? '?' : initialsOf(e.actor)}
      </span>
      <div className="h-main">
        <p className="h-text">
          <Sentence event={e} />
        </p>
        <p className="h-meta">
          <When at={e.at} now={now} />
          {someone && <span> · no display name set</span>}
          {e.restores && (
            <span>
              {' '}
              · undoes {e.restores.actor}’s change from <When at={e.restores.at} now={now} plain />
            </span>
          )}
          {e.restoredBy && (
            <span className="h-restored">
              {' '}
              · restored by {e.restoredBy.actor}, <When at={e.restoredBy.at} now={now} plain />
            </span>
          )}
        </p>
      </div>
      {e.restoredBy ? (
        <span className="badge badge-success h-badge">Restored</span>
      ) : (
        e.restorable &&
        (phone ? (
          <button
            type="button"
            className="icon-btn icon-btn-tint h-restore"
            onClick={() => onRestore(e)}
            disabled={paused}
            aria-label={`Restore: ${sentence(e)}`}
            title="Restore"
          >
            <RestoreIcon size={18} />
          </button>
        ) : (
          <button type="button" className="btn btn-tint btn-sm h-restore" onClick={() => onRestore(e)} disabled={paused} aria-label={`Restore: ${sentence(e)}`}>
            <RestoreIcon />
            Restore
          </button>
        ))
      )}
    </li>
  );
}

/** "<b>Bunzato</b> moved <b>Valheim</b> · Now Playing → Played", from the server's declared line. */
function Sentence({ event: e }) {
  const { verb, subject, detail, tone } = e.line;
  return (
    <>
      <b>{e.actor}</b> {verb}
      {subject && (
        <>
          {' '}
          <b className={tone === 'del' ? 'h-del' : undefined}>{subject}</b>
        </>
      )}
      {detail}
    </>
  );
}
const sentence = (e) => `${e.actor} ${e.line.verb}${e.line.subject ? ` ${e.line.subject}` : ''}${e.line.detail}`;

/**
 * When it happened: relative today ("12 min ago"), the clock time on earlier days (under their date). The exact time
 * shows on hover (title), and on a tap or a long press, which toggles it in place.
 */
function When({ at, now, plain = false }) {
  const [exact, setExact] = useState(false);
  const hold = useRef(null);
  const full = exactTime(at);
  const short = plain ? shortWhen(at, now, { withDay: true }) : shortWhen(at, now);
  const stop = () => clearTimeout(hold.current);
  useEffect(() => {
    return () => {
      clearTimeout(hold.current);
    };
  }, []);
  return (
    <time
      className="h-when"
      dateTime={at}
      title={full}
      tabIndex={0}
      onClick={() => setExact((x) => !x)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          setExact((x) => !x);
        }
      }}
      onPointerDown={(ev) => {
        if (ev.pointerType !== 'touch') return;
        stop();
        hold.current = setTimeout(() => setExact(true), 450);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={(ev) => ev.preventDefault()}
    >
      {exact ? full : short}
    </time>
  );
}

/**
 * Restore's confirmation (design/v1 History "Restore confirmation" and "Restore a move"): what changes, now vs after,
 * worked out by the server from the board as it is now. Restoring sends back the confirmation's token; if the board
 * changed in between, the new confirmation replaces this one instead of doing something nobody agreed to.
 */
function RestoreSheet({ code, event, now, onClose, onDone, onStale, onLocked }) {
  const titleId = useId();
  const paused = usePaused();
  const [withCard, setWithCard] = useState(false);
  const [state, setState] = useState({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ onLocked });
  latest.current = { onLocked };

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    previewRestore(code, event.id, { withCard }).then((r) => {
      if (!live) return;
      if (r.kind === 'locked') latest.current.onLocked(r.changed);
      else setState(r);
    });
    return () => {
      live = false;
    };
  }, [code, event.id, withCard, attempt]);

  const confirm = async () => {
    if (busy || state.kind !== 'preview') return;
    setBusy(true);
    const r = await restoreEvent(code, event.id, { token: state.preview.token, withCard });
    setBusy(false);
    if (r.kind === 'restored') return onDone(r);
    if (r.kind === 'locked') return onLocked(r.changed);
    if (r.kind === 'changed') return setState({ kind: 'preview', preview: r.preview, changed: r.error });
    if (r.kind === 'error') return setState({ ...state, failure: r.offline ? 'offline' : 'error' });
    return setState(r);
  };

  const name = readDisplayName() ?? 'Someone';
  const cancel = (
    <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>
      Cancel
    </button>
  );

  let body;
  if (state.kind === 'loading') {
    body = (
      <div className="restore-loading" aria-busy="true">
        <span className="spin" aria-hidden="true" />
        Working out what restoring changes…
      </div>
    );
  } else if (state.kind === 'preview') {
    const p = state.preview;
    body = (
      <>
        <div className="restore-head">
          <h2 id={titleId} className="display modal-title">
            {p.title}
          </h2>
          <p className="modal-text">{p.text}</p>
          <p className="restore-of">
            Undoes: <Sentence event={event} />, <When at={event.at} now={now} plain />
          </p>
        </div>
        {state.changed && (
          <p className="banner banner-warn" role="status">
            <WarningIcon />
            <span className="banner-text">{state.changed}</span>
          </p>
        )}
        <div className="diff" role="table" aria-label="What changes">
          <div className="diff-row diff-headrow" role="row">
            <span role="columnheader">
              <span className="sr-only">What</span>
            </span>
            <span className="k" role="columnheader">
              Now
            </span>
            <span className="k" role="columnheader">
              After restore
            </span>
          </div>
          {p.rows.map((row) => (
            <div className="diff-row" role="row" key={row.label}>
              <span className="k" role="rowheader">
                {row.label}
              </span>
              <span className={`old${row.now.kind === 'info' ? ' mono' : ''}`} role="cell">
                {showValue(row.now)}
              </span>
              <span className={`new${row.after.kind === 'info' ? ' mono' : ''}`} role="cell">
                {showValue(row.after)}
              </span>
            </div>
          ))}
        </div>
        {p.notes.map((n) => (
          <p key={n} className="restore-note">
            {n}
          </p>
        ))}
        <p className="restore-foot">
          The restore is logged as a new change by {name}. Nothing is lost: {event.actor}’s change stays in the history.
        </p>
        {state.failure && (
          <p className="field-error" role="alert">
            {state.failure === 'offline' ? 'You’re offline, so nothing was restored. Editing paused until we reconnect.' : 'Couldn’t restore it. Nothing changed; try again.'}
          </p>
        )}
        <div className="modal-actions">
          {cancel}
          <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={busy || undefined} disabled={paused} data-autofocus>
            {busy ? <span className="spin" aria-hidden="true" /> : <RestoreIcon size={18} />}
            {p.action}
          </button>
        </div>
      </>
    );
  } else if (state.kind === 'refused' && state.code === 'card_deleted' && state.canRestoreCard) {
    body = (
      <>
        <div className="restore-head">
          <h2 id={titleId} className="display modal-title">
            {state.title} was deleted
          </h2>
          <p className="modal-text">{state.error} To restore this change, the card has to come back too.</p>
        </div>
        <div className="modal-actions">
          {cancel}
          <button type="button" className="btn btn-primary" onClick={() => setWithCard(true)} data-autofocus>
            <RestoreIcon size={18} />
            Bring the card back too
          </button>
        </div>
      </>
    );
  } else {
    // Refused (already restored, already like that, a cap, a name signed up again …), gone, or couldn't load.
    const failed = state.kind === 'error';
    const heading = failed ? (state.offline ? 'You’re offline' : 'Couldn’t check this restore') : state.code === 'already_restored' ? 'Already restored' : 'Can’t restore this';
    const text = failed
      ? state.offline
        ? 'Restoring needs a connection. Editing paused until we reconnect.'
        : 'Next Up didn’t answer. Nothing has changed.'
      : state.kind === 'gone'
        ? 'That change is no longer on this board.'
        : state.error;
    body = (
      <>
        <div className="restore-head">
          <span className={`icon-circle icon-circle-sm ${failed ? 'ic-err' : 'ic-neutral'}`}>
            <WarningIcon />
          </span>
          <h2 id={titleId} className="display modal-title">
            {heading}
          </h2>
          <p className="modal-text">{text}</p>
        </div>
        <div className="modal-actions">
          {failed ? (
            <>
              {cancel}
              <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)} data-autofocus>
                <RetryIcon size={16} />
                Retry
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={state.code === 'already_restored' ? onStale : onClose} data-autofocus>
              OK
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <Overlay kind="modal" labelledBy={titleId} onClose={busy ? () => {} : onClose} className="restore-sheet">
      <div className="modal-body">{body}</div>
    </Overlay>
  );
}

/** A confirmation row's value, by what kind of value it is (never by event type). */
function showValue({ kind, value }) {
  if (value === null || value === undefined || value === '') {
    if (kind === 'date') return 'Not set';
    if (kind === 'info') return 'None';
    if (kind === 'logo') return 'No logo';
    return '—';
  }
  if (kind === 'lane') return laneName(value) ?? value;
  if (kind === 'date') return formatDate(value) || value;
  if (kind === 'logo') return logoById(value)?.name ?? value;
  if (kind === 'place') return `${ordinal(value.index + 1)} of ${value.of}`;
  return String(value);
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

// ---------- time ----------

/** The current time, ticking each minute so "5 min ago" stays true while the panel is open. */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      clearInterval(t);
    };
  }, []);
  return now;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function dayLabel(at, now) {
  const d = new Date(at);
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function shortWhen(at, now, { withDay = false } = {}) {
  const d = new Date(at);
  const mins = Math.floor((now - d) / 60_000);
  if (sameDay(d, now)) {
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return `${Math.floor(mins / 60)} h ago`;
  }
  return withDay ? `${dayLabel(at, now)} ${clock(d)}` : clock(d);
}

function exactTime(at) {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
