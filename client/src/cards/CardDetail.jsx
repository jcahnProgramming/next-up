import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CalendarIcon } from '../chrome/DatePicker.jsx';
import { CloseIcon, CopyIcon, ErrorIcon, PlusIcon, RetryIcon, WarningIcon } from '../chrome/icons.jsx';
import { copyText } from '../chrome/copyText.js';
import { usePhone } from '../chrome/usePhone.js';
import { useAskName } from '../prefs/NamePrompt.jsx';
import { readDisplayName } from '../prefs/displayName.js';
import { MAX_PLAYERS, PLAYER_NAME_MAX, checkPlayerName, playerExistsMessage, playerKey, playerLimitMessage } from '../../../server/core/cardDetail.js';
import { addPlayer, loadPlayers, removePlayer } from './api.js';
import { formatDate, relativeTo, todayString } from './dates.js';
import { linkify } from './linkify.js';

/**
 * The card panel's three sections (design/v1 Detail-Desktop, Detail-Phone 1 and 2):
 *
 *   GoLive       the date, or "Not set" with Set date
 *   ServerInfo   the text with its http(s) links clickable, and Copy all; or "No server info yet"
 *   Players      who's signed up, added and removed right here (no edit mode)
 *
 * "Not set" (nothing there) and "Couldn't load" (we don't know) never look alike: the first is a neutral badge or
 * the dashed empty box, the second the error tint with Retry.
 */

export function GoLive({ value, paused, onSet }) {
  const today = todayString();
  return (
    <section className="detail-section" aria-labelledby="detail-golive">
      <h3 id="detail-golive" className="section-label">
        <CalendarIcon size={14} />
        Go-live date
      </h3>
      {value ? (
        <div className="golive">
          <time className="golive-date" dateTime={value}>
            {formatDate(value)}
          </time>
          <span className={`badge ${value <= today ? 'badge-success' : 'badge-accent'}`}>{relativeTo(value, today)}</span>
        </div>
      ) : (
        <div className="golive">
          <span className="badge badge-unset">Not set</span>
          <span className="grow" />
          <button type="button" className="btn btn-tint btn-sm" onClick={onSet} disabled={paused}>
            <CalendarIcon size={16} />
            Set date
          </button>
        </div>
      )}
    </section>
  );
}

export function ServerInfo({ value, paused, onSet, toast }) {
  const copy = async () => {
    if (await copyText(value)) toast('Copied');
    else toast('Couldn’t copy. Select the text and copy it instead.', 'error');
  };
  return (
    <section className="detail-section" aria-labelledby="detail-server">
      <div className="section-row">
        <h3 id="detail-server" className="section-label grow">
          <ServerIcon />
          Server info
        </h3>
        {value && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
            <CopyIcon size={14} />
            Copy all
          </button>
        )}
      </div>
      {value ? (
        <div className="server-info">
          {linkify(value).map((piece, i) =>
            piece.href ? (
              <a key={i} href={piece.href} target="_blank" rel="noopener noreferrer">
                {piece.text}
              </a>
            ) : (
              <span key={i}>{piece.text}</span>
            ),
          )}
        </div>
      ) : (
        <div className="st-empty detail-empty">
          <span className="detail-empty-text">No server info yet.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSet} disabled={paused}>
            Add server info
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Sign-ups. Loaded when the panel opens (Loading players · Couldn't load players · the list). "+ Add Player" asks for
 * this browser's display name first if it never has (adding is a change), then opens an inline box, pre-filled with
 * that name unless it's already on the card: still editable, so anyone can add someone else. Enter adds and keeps the
 * box open for the next name. A name already on the card (ignoring case) is refused inline before anything is sent,
 * and again by the server. Each chip's × removes that player at once, with no confirmation: History will be able to
 * put them back.
 */
export function Players({ code, card, paused, onCount, onLocked, onGone }) {
  const askName = useAskName();
  const phone = usePhone();
  const inputId = useId();
  const errorId = useId();
  const input = useRef(null);
  const addButton = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState({ kind: 'loading' });
  const [list, setList] = useState([]);
  const [box, setBox] = useState(null); // null: closed; { draft, error, busy }
  const [removing, setRemoving] = useState(() => new Set());
  const [said, setSaid] = useState('');
  // The board hands in fresh callbacks on every render; the load mustn't re-run for that.
  const latest = useRef({ card, onCount, onLocked, onGone });
  latest.current = { card, onCount, onLocked, onGone };

  useEffect(() => {
    let live = true;
    setLoad({ kind: 'loading' });
    loadPlayers(code, latest.current.card).then((r) => {
      if (!live) return;
      const { onCount: count, onLocked: locked, onGone: gone } = latest.current;
      if (r.kind === 'ok') {
        setList(r.players);
        setLoad({ kind: 'ready' });
        count(r.players.length);
      } else if (r.kind === 'locked') locked(r.changed);
      else if (r.kind === 'gone') gone();
      else setLoad({ kind: 'error', offline: r.offline });
    });
    return () => {
      live = false;
    };
  }, [code, card.id, attempt]);

  const boxOpen = box !== null;
  const boxBusy = box?.busy ?? false;
  useEffect(() => {
    if (boxOpen && !boxBusy) input.current?.focus({ preventScroll: true });
  }, [boxOpen, boxBusy]);

  const full = list.length >= MAX_PLAYERS;
  const has = useCallback((name) => list.find((p) => playerKey(p.name) === playerKey(name)) ?? null, [list]);

  const openBox = async () => {
    if (!(await askName(`add a player to ${card.title}`))) return;
    const mine = readDisplayName();
    setBox({ draft: mine && !has(mine) ? mine : '', error: null, busy: false });
  };
  const closeBox = () => {
    setBox(null);
    requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!box || box.busy) return;
    const checked = checkPlayerName(box.draft);
    if (!checked.ok) return setBox({ ...box, error: checked.error });
    const already = has(checked.name);
    if (already) return setBox({ ...box, error: playerExistsMessage(already.name) });
    if (full) return setBox({ ...box, error: `${playerLimitMessage} Remove someone to add another.` });
    if (!(await askName(`add ${checked.name} to ${card.title}`))) return undefined;
    setBox({ ...box, busy: true, error: null });
    const r = await addPlayer(code, card, checked.name);
    if (r.kind === 'ok') {
      setList((l) => (l.some((p) => p.id === r.player.id) ? l : [...l, r.player]));
      onCount(r.playerCount);
      setSaid(`Added ${r.player.name}. ${r.playerCount === 1 ? '1 player' : `${r.playerCount} players`}.`);
      setBox({ draft: '', error: null, busy: false });
      return undefined;
    }
    if (r.kind === 'locked') return onLocked(r.changed);
    if (r.kind === 'gone') return onGone();
    const error =
      r.kind === 'exists' || r.kind === 'invalid'
        ? r.error
        : r.kind === 'players-full'
          ? `${r.error} Remove someone to add another.`
          : r.offline
            ? `You’re offline, so ${checked.name} wasn’t added. Editing paused until we reconnect.`
            : `Couldn’t add ${checked.name}. Nothing was saved; try again.`;
    // Someone else's sign-up we hadn't seen yet: show it, so the refusal makes sense.
    if (r.kind === 'exists' && r.player) setList((l) => (l.some((p) => p.id === r.player.id) ? l : [...l, r.player]));
    if (r.kind === 'players-full') setAttempt((n) => n + 1);
    setBox((b) => b && { ...b, busy: false, error });
    return undefined;
  };

  const remove = async (player) => {
    if (removing.has(player.id)) return;
    if (!(await askName(`remove ${player.name} from ${card.title}`))) return;
    setRemoving((s) => new Set(s).add(player.id));
    const r = await removePlayer(code, card, player);
    setRemoving((s) => {
      const next = new Set(s);
      next.delete(player.id);
      return next;
    });
    if (r.kind === 'ok' || r.kind === 'player-gone') {
      setList((l) => l.filter((p) => p.id !== player.id));
      if (r.kind === 'ok') onCount(r.playerCount);
      setSaid(r.kind === 'ok' ? `Removed ${player.name}.` : `${player.name} had already been removed.`);
      if (r.kind === 'player-gone') setAttempt((n) => n + 1);
    } else if (r.kind === 'locked') onLocked(r.changed);
    else if (r.kind === 'gone') onGone();
    else setSaid(r.offline ? `You’re offline, so ${player.name} wasn’t removed.` : `Couldn’t remove ${player.name}. Try again.`);
  };

  const n = list.length;
  return (
    <section className="detail-section" aria-labelledby="detail-players">
      <h3 id="detail-players" className="section-label">
        <PlayersIcon />
        {load.kind === 'ready' ? `Players · ${n}` : 'Players'}
      </h3>

      {load.kind === 'loading' && (
        <div className="players-loading" aria-busy="true" aria-label="Loading players">
          <span className="sk sk-chip" />
          <span className="sk sk-chip" />
          <span className="sk sk-chip" />
        </div>
      )}
      {load.kind === 'error' && (
        <div className="st-error detail-error" role="alert">
          <WarningIcon />
          <span className="detail-error-text">
            <b>{load.offline ? 'You’re offline.' : 'Couldn’t load players.'}</b>{' '}
            {load.offline ? 'Sign-ups need a connection.' : 'The rest of the card is fine.'}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt((x) => x + 1)}>
            <RetryIcon size={16} />
            Retry
          </button>
        </div>
      )}

      {load.kind === 'ready' && n === 0 && !box && (
        <div className="st-empty detail-empty">
          <span className="detail-empty-title">Nobody signed up yet</span>
          <span className="detail-empty-text">Be the first.</span>
        </div>
      )}
      {load.kind === 'ready' && n > 0 && (
        <ul className="players" aria-label={n === 1 ? '1 player' : `${n} players`}>
          {list.map((p) => (
            <li key={p.id} className="chip">
              <span className={`av ${hueOf(p.name)}`} aria-hidden="true">
                {initialsOf(p.name)}
              </span>
              <span className="chip-name">{p.name}</span>
              <button
                type="button"
                className="x"
                onClick={() => remove(p)}
                disabled={paused || removing.has(p.id)}
                aria-label={`Remove ${p.name}`}
                title={`Remove ${p.name}`}
              >
                {removing.has(p.id) ? <span className="spin" aria-hidden="true" /> : <CloseIcon size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {load.kind === 'ready' &&
        (box ? (
          <form className="player-form" onSubmit={submit} noValidate>
            <label className="sr-only" htmlFor={inputId}>
              Player name
            </label>
            <div className="player-form-row">
              <input
                ref={input}
                id={inputId}
                className="field-input player-input"
                value={box.draft}
                onChange={(e) => setBox({ ...box, draft: e.target.value, error: null })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeBox();
                  }
                }}
                maxLength={PLAYER_NAME_MAX * 2}
                placeholder="Player name"
                autoComplete="off"
                enterKeyHint="done"
                disabled={box.busy}
                aria-invalid={box.error ? 'true' : undefined}
                aria-describedby={box.error ? errorId : undefined}
              />
              <button type="submit" className="btn btn-primary" aria-disabled={box.busy || paused || undefined} disabled={paused}>
                {box.busy ? (
                  <>
                    <span className="spin" aria-hidden="true" />
                    Adding…
                  </>
                ) : (
                  'Add'
                )}
              </button>
              <button type="button" className="icon-btn icon-btn-fill" onClick={closeBox} aria-label="Stop adding players" title="Done adding">
                <CloseIcon />
              </button>
            </div>
            {box.error ? (
              <span id={errorId} className="field-error" role="alert">
                <ErrorIcon />
                {box.error}
              </span>
            ) : (
              <span className="field-hint">Enter adds and keeps the box open for the next name.</span>
            )}
          </form>
        ) : full ? (
          <p className="field-hint">{playerLimitMessage} Remove someone to add another.</p>
        ) : (
          <button
            ref={addButton}
            type="button"
            className={`btn btn-tint player-add${phone ? ' btn-block' : ''}`}
            onClick={openBox}
            disabled={paused}
          >
            <PlusIcon />
            Add Player
          </button>
        ))}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </section>
  );
}

/** Two letters for the avatar: the first of two words, or the first two of one. */
export function initialsOf(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [[...words[0]][0], [...words[1]][0]] : [...(words[0] ?? '')].slice(0, 2);
  return letters.join('').toUpperCase();
}

/** One of the eight avatar hues (nu.css .h1–.h8), the same for a name wherever it appears. */
export function hueOf(name) {
  let h = 0;
  for (const ch of playerKey(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `h${(h % 8) + 1}`;
}

function ServerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

export function PlayersIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
    </svg>
  );
}
