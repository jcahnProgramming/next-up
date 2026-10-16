import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PlusIcon, RetryIcon, WarningIcon } from '../chrome/icons.jsx';
import { useTopbar } from '../chrome/topbar.jsx';
import { useOnline } from '../chrome/useOnline.js';
import { usePhone } from '../chrome/usePhone.js';
import { useAskName } from '../prefs/NamePrompt.jsx';
import { LANES, MAX_CARDS, laneName } from '../../../server/core/cardRules.js';
import { keyBetween, tooLong } from '../../../server/core/positions.js';
import { addCard, deleteCard, editCard, loadCards, moveCard } from './api.js';
import { CardPill } from './Card.jsx';
import { CardEditor, CardPanel, ConfirmDelete } from './CardSheets.jsx';
import { HistoryPanel } from '../history/HistoryPanel.jsx';
import { useCardDrag } from './useCardDrag.js';
import './board.css';

/**
 * An open board (design/v1 Board-Desktop, Board-States, Board-Phone, Board-Phone-States): three lanes, side by side
 * on a desktop and stacked on a phone, each with its cards in order and an add button.
 *
 *   loading (shimmer pills) · couldn't load (Retry) · the lanes · offline (the board as loaded, editing paused)
 *
 * Changes go through the name prompt first, then the API; the board shows what the server answered. Other people's
 * changes appear on reload (live sync comes later). A board that locks under us (lock pressed in another tab, or its
 * password changed) goes back to its lock screen via onLocked.
 *
 * Cards move by drag and drop, long-press on a phone, or the keyboard (useCardDrag.js); every step is announced in
 * a live region. A drop shows the card in its new place at once and puts it back if the server refuses.
 *
 * History (`history`, opened from the top bar or a card's panel; history/HistoryPanel.jsx) lists the board's changes
 * and restores them; after a restore the board reloads, since a restore can move, bring back or change any card.
 */
export function Board({ board, onLocked, history, onHistory }) {
  const code = board.code;
  const { toast } = useTopbar();
  const askName = useAskName();
  const online = useOnline();
  const phone = usePhone();
  const lanesRef = useRef(null);
  const hintId = useId();
  const [said, setSaid] = useState({ text: '', n: 0 });
  const announce = useCallback((text) => setSaid((p) => ({ text, n: p.n + 1 })), []);
  const [load, setLoad] = useState({ kind: 'loading' });
  const [data, setData] = useState(null); // { cards, limit, loadedAt }
  const [sheet, setSheet] = useState(null); // { mode: 'view' | 'edit' | 'add' | 'delete', id?, lane?, back?, focus? }
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    loadCards(code).then((r) => {
      if (!live) return;
      if (r.kind === 'ok') {
        setData({ cards: r.cards, limit: r.limit ?? MAX_CARDS, loadedAt: new Date() });
        setLoad({ kind: 'ready' });
      } else if (r.kind === 'locked') {
        onLocked(r.changed);
      } else {
        setLoad({ kind: 'error', offline: r.offline });
      }
    });
    return () => {
      live = false;
    };
  }, [code, attempt, onLocked]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const upsert = useCallback((card) => {
    setData((d) => ({ ...d, cards: [...d.cards.filter((c) => c.id !== card.id), card] }));
  }, []);
  const drop = useCallback((id) => {
    setData((d) => ({ ...d, cards: d.cards.filter((c) => c.id !== id) }));
  }, []);
  // Sign-ups change only the card's count; its version stays (server/players/routes.js).
  const setPlayerCount = useCallback((id, playerCount) => {
    setData((d) => ({ ...d, cards: d.cards.map((c) => (c.id === id && c.playerCount !== playerCount ? { ...c, playerCount } : c)) }));
  }, []);

  const lanes = useMemo(() => {
    const by = Object.fromEntries(LANES.map((l) => [l.id, []]));
    for (const c of data?.cards ?? []) by[c.lane]?.push(c);
    for (const list of Object.values(by)) list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id - b.id));
    return by;
  }, [data]);

  const cardById = (id) => data?.cards.find((c) => c.id === id) ?? null;
  const total = data?.cards.length ?? 0;
  const full = data ? total >= data.limit : false;
  const paused = !online;

  // ---- changes: each resolves to the API's result so the sheet can show what went wrong ----
  const common = (r) => {
    if (r.kind === 'locked') {
      setSheet(null);
      onLocked(r.changed);
    }
    return r;
  };

  const save = async (mode, card, values) => {
    if (mode === 'add') {
      if (!(await askName(`add ${values.title} to ${laneName(values.lane)}`))) return { kind: 'cancelled' };
      const r = common(await addCard(code, values));
      if (r.kind === 'ok') {
        upsert(r.card);
        setSheet(null);
        toast(`Added ${r.card.title} to ${laneName(r.card.lane)}`);
      }
      if (r.kind === 'full') setData((d) => ({ ...d, limit: Math.min(d.limit, d.cards.length) }));
      return r;
    }
    if (!(await askName(`save your changes to ${card.title}`))) return { kind: 'cancelled' };
    const r = common(await editCard(code, card, values));
    if (r.kind === 'ok') {
      upsert(r.card);
      setSheet({ mode: 'view', id: r.card.id });
      if (r.card.lane !== card.lane) toast(`Moved ${r.card.title} to ${laneName(r.card.lane)}`);
    } else if (r.kind === 'conflict') {
      upsert(r.card);
    } else if (r.kind === 'gone') {
      drop(card.id);
      setSheet(null);
      toast(`${card.title} was deleted by someone else, so your changes weren’t saved.`, 'error');
    }
    return r;
  };

  const remove = async (card) => {
    if (!(await askName(`delete ${card.title}`))) return { kind: 'cancelled' };
    const r = common(await deleteCard(code, card));
    if (r.kind === 'ok' || r.kind === 'gone') {
      drop(card.id);
      setSheet(null);
      toast(r.kind === 'ok' ? `Deleted ${card.title}` : `${card.title} had already been deleted.`);
    } else if (r.kind === 'conflict') {
      upsert(r.card);
    }
    return r;
  };

  // A drop (useCardDrag): the card shows in its new place straight away; the server writes that one card's lane and
  // position, and if it refuses, the card goes back. `to.index` counts the lane's other cards, as the server does.
  const move = async (card, to) => {
    const others = lanes[to.lane].filter((c) => c.id !== card.id);
    const above = others[to.index - 1] ?? null;
    const guess = keyGuess(above?.position ?? null, others[to.index]?.position ?? null);
    if (guess) upsert({ ...card, lane: to.lane, position: guess });
    const undo = () => upsert(card);
    if (!(await askName(`move ${card.title}`))) return undo();
    const r = common(await moveCard(code, card, { lane: to.lane, index: to.index, afterId: above ? above.id : null }));
    if (r.kind === 'ok') {
      upsert(r.card);
      if (r.rebalanced) reload(); // other cards' keys changed on the server
    } else if (r.kind === 'gone') {
      drop(card.id);
      toast(`${card.title} was deleted by someone else.`, 'error');
    } else if (r.kind !== 'locked') {
      undo();
      toast(r.offline ? `You’re offline, so ${card.title} didn’t move.` : `Couldn’t move ${card.title}. It’s back where it was.`, 'error');
    }
    return undefined;
  };

  const dnd = useCardDrag({ enabled: load.kind === 'ready' && online && !sheet && !history, lanes, rootRef: lanesRef, onDrop: move, announce });
  const drag = dnd.drag;

  const openAdd = (lane) => setSheet({ mode: 'add', lane });
  const open = (card) => setSheet({ mode: 'view', id: card.id });

  // ---- render ----
  if (load.kind === 'loading' || (load.kind === 'error' && !data)) {
    return (
      <div className="board">
        <h1 className="sr-only">
          Board <span className="code-text">{code}</span>
        </h1>
        {load.kind === 'loading' ? <Skeleton /> : <LoadError offline={load.offline} onRetry={reload} />}
      </div>
    );
  }

  const empty = total === 0;
  const sheetCard = sheet?.id ? cardById(sheet.id) : null;

  return (
    <div className="board">
      <h1 className="sr-only">
        Board <span className="code-text">{code}</span>, {total === 1 ? '1 game' : `${total} games`}
      </h1>

      {paused && (
        <div className="banner banner-err board-banner" role="status">
          <OfflineIcon />
          <span className="banner-text">
            <b>You’re offline.</b> Showing the board as it was at {formatTime(data.loadedAt)}. Editing paused until we
            reconnect.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {!paused && load.kind === 'error' && (
        <div className="banner banner-err board-banner" role="alert">
          <WarningIcon />
          <span className="banner-text">
            <b>Couldn’t refresh the board.</b> Showing it as it was at {formatTime(data.loadedAt)}.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {full && !paused && (
        <p className="banner banner-info board-banner" role="status">
          <span className="banner-text">
            <b>This board is full.</b> It holds {data.limit} games, the most a board can. Delete one to add another.
          </span>
        </p>
      )}

      <div
        ref={lanesRef}
        className={`lanes${paused ? ' is-stale' : ''}${drag ? ' is-dragging' : ''}${dnd.settling ? ' is-settling' : ''}`}
      >
        {LANES.map((lane) => (
          <Lane
            key={lane.id}
            lane={lane}
            cards={lanes[lane.id]}
            boardEmpty={empty}
            canAdd={!paused && !full}
            onAdd={() => openAdd(lane.id)}
            onOpen={open}
            dnd={paused ? null : dnd}
            drag={drag}
            phone={phone}
            describedBy={paused ? undefined : hintId}
          />
        ))}
      </div>

      <p id={hintId} className="sr-only">
        Enter opens it. To move it, press Space, then the arrow keys; Space drops it and Escape cancels.
      </p>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {/* An alternating no-break space makes a repeated message ("position 1 of 3" twice) announce again. */}
        {said.text}
        {said.n % 2 ? ' ' : ''}
      </div>
      {drag && phone && drag.mode === 'pointer' && !drag.scrolling && <DragHint drag={drag} card={cardById(drag.id)} />}
      {drag?.scrolling && (
        <div className={`autoscroll autoscroll-${drag.scrolling}`} aria-hidden="true">
          <span>
            <ArrowIcon down={drag.scrolling === 'down'} />
            Scrolling {drag.scrolling}
          </span>
        </div>
      )}

      {sheet?.mode === 'view' && sheetCard && (
        <CardPanel
          code={code}
          card={sheetCard}
          paused={paused}
          toast={toast}
          onEdit={(focus) => setSheet({ mode: 'edit', id: sheetCard.id, back: 'view', focus })}
          onDelete={() => setSheet({ mode: 'delete', id: sheetCard.id, back: 'view' })}
          onHistory={() => {
            setSheet(null);
            onHistory({ cardId: sheetCard.id, back: sheetCard.id });
          }}
          onClose={() => setSheet(null)}
          onCount={(n) => setPlayerCount(sheetCard.id, n)}
          onLocked={(changed) => common({ kind: 'locked', changed })}
          onGone={() => {
            drop(sheetCard.id);
            setSheet(null);
            toast(`${sheetCard.title} was deleted by someone else.`, 'error');
          }}
        />
      )}
      {(sheet?.mode === 'add' || (sheet?.mode === 'edit' && sheetCard)) && (
        <CardEditor
          key={sheet.mode === 'add' ? 'add' : `edit-${sheet.id}`}
          card={sheet.mode === 'edit' ? sheetCard : null}
          lane={sheet.lane}
          focus={sheet.focus}
          paused={paused}
          full={full}
          onSave={(values) => save(sheet.mode, sheetCard, values)}
          onDelete={() => setSheet({ mode: 'delete', id: sheetCard.id, back: 'edit' })}
          onClose={() => setSheet(sheet.back === 'view' ? { mode: 'view', id: sheet.id } : null)}
        />
      )}
      {history && (
        <HistoryPanel
          key={history.cardId ?? 'board'}
          code={code}
          cardId={history.cardId}
          onClose={() => {
            // Opened from a card: back to that card, if it's still on the board.
            if (history.back && cardById(history.back)) setSheet({ mode: 'view', id: history.back });
            onHistory(null);
          }}
          onLocked={(changed) => common({ kind: 'locked', changed })}
          onRestored={(r) => {
            reload();
            toast(r.rebalanced ? 'Restored. The board has been reloaded.' : 'Restored. History shows it as a new change.');
          }}
        />
      )}
      {sheet?.mode === 'delete' && sheetCard && (
        <ConfirmDelete
          card={sheetCard}
          paused={paused}
          onDelete={() => remove(sheetCard)}
          onClose={() => setSheet({ mode: sheet.back, id: sheet.id, back: sheet.back === 'edit' ? 'view' : undefined })}
        />
      )}
    </div>
  );
}

/**
 * A lane. During a drag (`drag`) nothing in it re-orders: each card slides by whole card pitches to where it will
 * be (--shift), the list grows or shrinks by --extra pitches, and the slot is drawn absolutely at --at. On drop the
 * real order changes and the shifts drop to zero in the same frame, so nothing jumps.
 */
function Lane({ lane, cards, boardEmpty, canAdd, onAdd, onOpen, dnd, drag, phone, describedBy }) {
  const headId = `lane-${lane.id}`;
  const n = cards.length;
  const isSource = Boolean(drag && cards.some((c) => c.id === drag.id));
  const isTarget = drag?.to.lane === lane.id;
  const others = drag ? cards.filter((c) => c.id !== drag.id) : cards;
  const shiftOf = (card, at) => {
    if (!drag || card.id === drag.id) return 0;
    const i = others.indexOf(card);
    return (isTarget && i >= drag.to.index ? i + 1 : i) - at;
  };
  // On a phone the header says what the drop will do (Board-Phone 3 and 4): "3 → 4", "4 + 1 moving", "Drop here".
  const moving = drag && phone && drag.from.lane !== drag.to.lane;
  const count = moving && isTarget ? `${n} → ${n + 1}` : moving && isSource ? `${n - 1} + 1 moving` : n;
  return (
    <section
      className={`lane glass-1${isTarget ? ' is-drop' : ''}${isSource ? ' is-source' : ''}`}
      aria-labelledby={headId}
      data-drop-lane={lane.id}
    >
      <div className={`lane-head${isTarget && phone ? ' is-target' : ''}`}>
        <span className={`lane-dot ld-${lane.id}`} aria-hidden="true" />
        <h2 id={headId} className="lane-name">
          {lane.name}
        </h2>
        <span className="lane-n" aria-label={n === 1 ? '1 game' : `${n} games`}>
          {count}
        </span>
        {isTarget && phone && <span className="lane-drop-here" aria-hidden="true">Drop here</span>}
        <button
          type="button"
          className="icon-btn lane-add-btn"
          onClick={onAdd}
          disabled={!canAdd}
          aria-label={`Add a game to ${lane.name}`}
          title={`Add a game to ${lane.name}`}
        >
          <PlusIcon />
        </button>
      </div>
      {boardEmpty && lane.id === 'up_next' ? (
        <div className="st-empty lane-fresh">
          <span className="icon-circle ic-accent">
            <PlusIcon size={24} />
          </span>
          <span className="display lane-fresh-title">A fresh board</span>
          <span className="lane-fresh-text">Add the first game the guild is thinking about.</span>
          <button type="button" className="btn btn-primary" onClick={onAdd} disabled={!canAdd}>
            <PlusIcon />
            Add a game
          </button>
        </div>
      ) : n === 0 && isTarget ? (
        <div className="card-slot" data-slot data-lane-list aria-hidden="true" />
      ) : n === 0 ? (
        <div className="lane-empty">{EMPTY[lane.id]}</div>
      ) : (
        <ol className="lane-cards" data-lane-list style={drag ? { '--extra': others.length + (isTarget ? 1 : 0) - n } : undefined}>
          {cards.map((card, at) => {
            const lifted = card.id === drag?.id;
            return (
              <li key={card.id} className={lifted ? 'is-dragged' : undefined} style={drag ? { '--shift': shiftOf(card, at) } : undefined}>
                {lifted && moving && (
                  <span className="from-tag" aria-hidden="true">
                    from {laneName(drag.from.lane)}
                  </span>
                )}
                <CardPill card={card} onOpen={onOpen} dnd={dnd} lifted={lifted} describedBy={describedBy} />
              </li>
            );
          })}
          {isTarget && <li className="card-slot is-placed" data-slot aria-hidden="true" style={{ '--at': drag.to.index }} />}
        </ol>
      )}
    </section>
  );
}

// Phone (Board-Phone 2 and 4): what letting go will do, where a toast would sit.
function DragHint({ drag, card }) {
  const same = drag.to.lane === drag.from.lane && drag.to.index === drag.from.index;
  return (
    <div className="drag-hint" aria-hidden="true">
      <span className="toast glass-2">
        {same || !card ? 'Drag to any lane. Release to drop.' : `Release to move ${card.title} to ${laneName(drag.to.lane)}, ${ordinal(drag.to.index + 1)}`}
      </span>
    </div>
  );
}

const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
};

// The key the server will most likely give a dropped card, so it shows in place before the answer arrives. Null when
// the gap is too tight to guess (the server will rebalance the lane, and the board reloads).
function keyGuess(above, below) {
  try {
    const key = keyBetween(above, below);
    return tooLong(key) ? null : key;
  } catch {
    return null;
  }
}

function ArrowIcon({ down }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={down ? 'M12 5v14M6 13l6 6 6-6' : 'M12 19V5M6 11l6-6 6 6'} />
    </svg>
  );
}

const EMPTY = { up_next: 'Nothing up next', now_playing: 'Nothing on yet', played: 'Nothing played yet' };

function Skeleton() {
  return (
    <div className="lanes" aria-busy="true" aria-label="Loading the board">
      {LANES.map((lane, i) => (
        <section key={lane.id} className="lane glass-1">
          <div className="lane-head">
            <span className={`lane-dot ld-${lane.id}`} aria-hidden="true" />
            <span className="lane-name">{lane.name}</span>
          </div>
          {Array.from({ length: [3, 1, 2][i] }, (_, j) => (
            <span key={j} className="sk sk-card" />
          ))}
        </section>
      ))}
    </div>
  );
}

function LoadError({ offline, onRetry }) {
  return (
    <div className="board-center">
      <section className="st-error board-error" role="alert">
        <span className="icon-circle ic-err">
          <WarningIcon />
        </span>
        <h2 className="display board-error-title">{offline ? 'You’re offline' : 'Couldn’t load this board'}</h2>
        <p className="board-error-text">
          {offline
            ? 'Boards need a connection to open. Nothing on the board has changed.'
            : 'Next Up didn’t answer. Nothing on the board has changed; we just couldn’t fetch it.'}
        </p>
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          <RetryIcon />
          Try again
        </button>
      </section>
    </div>
  );
}

function OfflineIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M2 8.5a15 15 0 0 1 5-3M22 8.5a15 15 0 0 0-11-3.9M9 15.5a5 5 0 0 1 6 0M3 3l18 18" />
    </svg>
  );
}

const formatTime = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
