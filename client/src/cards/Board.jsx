import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PlusIcon, RetryIcon, WarningIcon } from '../chrome/icons.jsx';
import { useTopbar } from '../chrome/topbar.jsx';
import { usePhone } from '../chrome/usePhone.js';
import { useAskName } from '../prefs/NamePrompt.jsx';
import { LANES, MAX_CARDS, laneName } from '../../../server/core/cardRules.js';
import { keyBetween, tooLong } from '../../../server/core/positions.js';
import { addCard, deleteCard, editCard, loadCards, moveCard } from './api.js';
import { CardPill } from './Card.jsx';
import { CardEditor, CardPanel, ConfirmDelete } from './CardSheets.jsx';
import { HistoryPanel } from '../history/HistoryPanel.jsx';
import { LiveContext, SyncBanner, sentenceOf, tagOf, useLive } from '../live/Live.jsx';
import { hueOf } from './CardDetail.jsx';
import { useCardDrag } from './useCardDrag.js';
import './board.css';

/**
 * An open board (design/v1 Board-Desktop, Board-States, Board-Phone, Board-Phone-States): three lanes, side by side
 * on a desktop and stacked on a phone, each with its cards in order and an add button.
 *
 *   loading (shimmer pills) · couldn't load (Retry) · the lanes · offline (the board as loaded, editing paused)
 *
 * Changes go through the name prompt first, then the API; the board shows what the server answered. Everyone else's
 * changes arrive live (live/): cards, details, players and an open History update in place, and a card someone
 * else changed wears the flash and name tag ("Bunzato moved this") for a moment. Mid-drag, changes wait for the
 * drop (a remote delete of the held card cancels the drag, saying so); an open edit sheet keeps what's being typed
 * and says "Changed by …"; a panel whose card was deleted says so. Editing pauses whenever the stream isn't live.
 * A board that locks under us (lock pressed in another tab, or its password changed) goes back to its lock screen
 * via onLocked.
 *
 * Cards move by drag and drop, long-press on a phone, or the keyboard (useCardDrag.js); every step is announced in
 * a live region. A drop shows the card in its new place at once and puts it back if the server refuses.
 *
 * History (`history`, opened from the top bar or a card's panel; history/HistoryPanel.jsx) lists the board's changes
 * and restores them; after a restore the board reloads, since a restore can move, bring back or change any card.
 */
export function Board({ board, onLocked, history, onHistory, onLive }) {
  const code = board.code;
  const { toast } = useTopbar();
  const askName = useAskName();
  const phone = usePhone();
  const lanesRef = useRef(null);
  const hintId = useId();
  const [said, setSaid] = useState({ text: '', n: 0 });
  const announce = useCallback((text) => setSaid((p) => ({ text, n: p.n + 1 })), []);
  const [heard, setHeard] = useState({ text: '', n: 0 }); // other people's changes, read out politely
  const [load, setLoad] = useState({ kind: 'loading' });
  const [data, setData] = useState(null); // { cards, limit, loadedAt }
  const [sheet, setSheet] = useState(null); // { mode: 'view' | 'edit' | 'add' | 'delete', id?, lane?, back?, focus?, gone? }
  const [attempt, setAttempt] = useState(0);
  // The event id the board first loaded at: where the live stream starts (live/Live.jsx). Null until then.
  const [head, setHead] = useState(null);
  const [flashes, setFlashes] = useState(() => new Map()); // card id → { tag, hue, n }: "Bunzato moved this"

  // Live changes, as they arrive (live/connection.js), in id order and each once.
  const latest = useRef({});
  const listeners = useRef(new Set());
  const held = useRef([]); // changes that arrived mid-drag, applied on the drop
  const replay = useRef(null); // changes that arrived while the board was reloading, applied again on top of it
  const moving = useRef(new Set()); // cards this tab has dropped and the server hasn't answered for yet
  const remoteBy = useRef(new Map()); // card id → who last changed it, someone else (the edit sheet's "Changed by")
  const flashTimers = useRef(new Set());

  useEffect(() => {
    let live = true;
    replay.current = [];
    loadCards(code).then((r) => {
      if (!live) return;
      const arrived = replay.current ?? [];
      replay.current = null;
      if (r.kind === 'ok') {
        const loaded = { cards: r.cards, limit: r.limit ?? MAX_CARDS, loadedAt: new Date() };
        // A change that arrived while this was loading may be newer than what it read: put it back on top.
        setData(arrived.reduce((d, m) => applyCard(d, m, moving.current), loaded));
        setHead((h) => h ?? r.head ?? null);
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

  // Only ever newer: an answer or a change that arrives after a newer one for the same card doesn't undo it.
  const upsert = useCallback((card) => {
    setData((d) => {
      const at = d.cards.find((c) => c.id === card.id);
      if (at && card.version < at.version) return d;
      return { ...d, cards: [...d.cards.filter((c) => c.id !== card.id), card] };
    });
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

  // ---- live sync ----
  const flash = (id, m) => {
    const n = m.entry.id;
    setFlashes((f) => new Map(f).set(id, { tag: tagOf(m), hue: hueOf(m.entry.actor), initials: [...m.entry.actor][0]?.toUpperCase() ?? '?', n }));
    const timer = setTimeout(() => {
      flashTimers.current.delete(timer);
      setFlashes((f) => {
        if (f.get(id)?.n !== n) return f;
        const next = new Map(f);
        next.delete(id);
        return next;
      });
    }, FLASH_MS);
    flashTimers.current.add(timer);
  };
  useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  const apply = (m) => {
    const { entry, card, own } = m;
    if (replay.current) replay.current.push(m);
    if (card) {
      const before = latest.current.data?.cards.find((c) => c.id === card.id) ?? null;
      setData((d) => (d ? applyCard(d, m, moving.current) : d));
      if (!own) {
        remoteBy.current.set(card.id, entry.actor);
        const open = latest.current.sheet;
        if (card.deleted && open?.id === card.id) {
          const title = before?.title ?? card.title;
          if (open.mode === 'delete') {
            setSheet(null);
            toast(`${entry.actor} deleted ${title} first.`);
          } else {
            // The panel or edit sheet stays, saying so, rather than showing a card that's gone.
            setSheet((sh) => (sh?.id === card.id ? { ...sh, gone: { card: before ?? withoutDeleted(card), actor: entry.actor } } : sh));
          }
        }
        if (!card.deleted) flash(card.id, m);
      }
    }
    if (!own) setHeard((h) => ({ text: `${sentenceOf(m)}.`, n: h.n + 1 }));
    for (const fn of listeners.current) fn(m);
  };

  const onChange = (m) => {
    const dragging = latest.current.drag;
    if (dragging) {
      // Never yank the card someone is holding: everything waits for the drop. Unless the card they hold is gone.
      held.current.push(m);
      if (m.card?.deleted && m.card.id === dragging.id) {
        latest.current.cancelDrag();
        toast(`${m.entry.actor} deleted ${cardById(dragging.id)?.title ?? m.card.title} while you were moving it.`, 'error');
      }
      return;
    }
    apply(m);
  };

  const live = useLive({
    code,
    head,
    onChange,
    onReset: () => {
      // Too far behind to replay: load the board afresh (the stream carries on from its head).
      reload();
      for (const fn of listeners.current) fn({ reset: true });
    },
    onLocked: (changed) => common({ kind: 'locked', changed }),
  });
  const paused = live.status !== 'live';
  const stale = paused && live.status !== 'connecting';
  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  const liveValue = useMemo(
    () => ({ status: live.status, why: live.why, since: live.since, retry: live.retry, subscribe }),
    [live.status, live.why, live.since, live.retry, subscribe],
  );

  // The top bar's sync pill (pages/BoardPage.jsx puts it there).
  useEffect(() => {
    onLive?.({ status: live.status, since: live.since });
  }, [onLive, live.status, live.since]);
  useEffect(() => {
    return () => {
      onLive?.(null);
    };
  }, [onLive]);

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
    // `card` is the card as the edit sheet opened it (or last loaded it): its version is what this edit is from, so
    // a change someone made since is a conflict, never silently overwritten.
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
    // While the answer is on its way, other people's changes to the lane don't put this card back where it was.
    moving.current.add(card.id);
    const r = common(await moveCard(code, card, { lane: to.lane, index: to.index, afterId: above ? above.id : null }));
    moving.current.delete(card.id);
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

  const dnd = useCardDrag({ enabled: load.kind === 'ready' && !paused && !sheet && !history, lanes, rootRef: lanesRef, onDrop: move, announce });
  const drag = dnd.drag;
  latest.current = { data, sheet, drag, cancelDrag: dnd.cancel };

  // The drop (or a cancel): what arrived meanwhile is applied now, in order.
  useEffect(() => {
    if (drag || held.current.length === 0) return;
    const waiting = held.current;
    held.current = [];
    for (const m of waiting) apply(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

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
  // A sheet's card, or (someone else deleted it while it was open) the card as it was, with who deleted it.
  const liveCard = sheet?.id ? cardById(sheet.id) : null;
  const sheetCard = liveCard ?? sheet?.gone?.card ?? null;
  const goneBy = !liveCard && sheet?.gone ? sheet.gone.actor : null;

  return (
    <LiveContext.Provider value={liveValue}>
    <div className="board">
      <h1 className="sr-only">
        Board <span className="code-text">{code}</span>, {total === 1 ? '1 game' : `${total} games`}
      </h1>

      <SyncBanner live={live} loadedAt={data.loadedAt} />
      {!stale && load.kind === 'error' && (
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
      {full && !stale && (
        <p className="banner banner-info board-banner" role="status">
          <span className="banner-text">
            <b>This board is full.</b> It holds {data.limit} games, the most a board can. Delete one to add another.
          </span>
        </p>
      )}

      <div
        ref={lanesRef}
        className={`lanes${stale ? ' is-stale' : ''}${drag ? ' is-dragging' : ''}${dnd.settling ? ' is-settling' : ''}`}
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
            flashes={flashes}
          />
        ))}
      </div>

      <p id={hintId} className="sr-only">
        Enter opens it. To move it, press Space, then the arrow keys; Space drops it and Escape cancels.
      </p>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {/* An alternating no-break space makes a repeated message ("position 1 of 3" twice) announce again. */}
        {said.text}
        {said.n % 2 ? ' ' : ''}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {heard.text}
        {heard.n % 2 ? ' ' : ''}
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
          goneBy={goneBy}
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
          changedBy={sheet.mode === 'edit' ? (remoteBy.current.get(sheet.id) ?? null) : null}
          goneBy={goneBy}
          lane={sheet.lane}
          focus={sheet.focus}
          paused={paused}
          full={full}
          onSave={(values, base) => save(sheet.mode, base, values)}
          onDelete={() => setSheet({ mode: 'delete', id: sheetCard.id, back: 'edit' })}
          onClose={() => setSheet(goneBy ? null : sheet.back === 'view' ? { mode: 'view', id: sheet.id } : null)}
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
            // The restore's changes arrive on the live stream like any other; a rebalanced lane needs a reload.
            if (r.rebalanced) reload();
            toast(r.rebalanced ? 'Restored. The board has been reloaded.' : 'Restored. History shows it as a new change.');
          }}
        />
      )}
      {sheet?.mode === 'delete' && liveCard && (
        <ConfirmDelete
          card={liveCard}
          paused={paused}
          onDelete={() => remove(liveCard)}
          onClose={() => setSheet({ mode: sheet.back, id: sheet.id, back: sheet.back === 'edit' ? 'view' : undefined })}
        />
      )}
    </div>
    </LiveContext.Provider>
  );
}

/**
 * A live change applied to the board's cards: the card as the server has it now (or gone), and its lane's keys as
 * they are now, so a rebalanced lane sorts right. Applying one twice changes nothing; one older than the card shown
 * is ignored. A card this tab has dropped and is waiting to hear back about keeps its new place.
 */
function applyCard(d, { card, lane }, moving) {
  if (!card) return d;
  const { deleted, ...body } = card;
  let cards = d.cards;
  const at = cards.findIndex((c) => c.id === body.id);
  if (deleted) {
    if (at !== -1) cards = cards.filter((c) => c.id !== body.id);
  } else if (at === -1) {
    cards = [...cards, body];
  } else if (body.version > cards[at].version || (body.version === cards[at].version && !moving.has(body.id))) {
    cards = cards.map((c) => (c.id === body.id ? body : c));
  }
  if (lane) {
    const keys = new Map(lane.cards);
    cards = cards.map((c) =>
      c.lane === lane.id && keys.has(c.id) && keys.get(c.id) !== c.position && !moving.has(c.id) ? { ...c, position: keys.get(c.id) } : c,
    );
  }
  return cards === d.cards ? d : { ...d, cards };
}

const withoutDeleted = ({ deleted, ...card }) => card; // eslint-disable-line no-unused-vars

/**
 * A lane. During a drag (`drag`) nothing in it re-orders: each card slides by whole card pitches to where it will
 * be (--shift), the list grows or shrinks by --extra pitches, and the slot is drawn absolutely at --at. On drop the
 * real order changes and the shifts drop to zero in the same frame, so nothing jumps.
 */
function Lane({ lane, cards, boardEmpty, canAdd, onAdd, onOpen, dnd, drag, phone, describedBy, flashes }) {
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
            const flash = flashes.get(card.id);
            return (
              <li key={card.id} className={lifted ? 'is-dragged' : undefined} style={drag ? { '--shift': shiftOf(card, at) } : undefined}>
                {lifted && moving && (
                  <span className="from-tag" aria-hidden="true">
                    from {laneName(drag.from.lane)}
                  </span>
                )}
                {flash && !lifted && (
                  // Someone else's change (Card-States): the ring and "Bunzato moved this", for a moment. Read out
                  // by the board's polite live region, so hidden here.
                  <span key={flash.n} className="flash-tag" aria-hidden="true">
                    <span className={`av ${flash.hue}`}>{flash.initials}</span>
                    <span className="flash-tag-text">{flash.tag}</span>
                  </span>
                )}
                <CardPill card={card} onOpen={onOpen} dnd={dnd} lifted={lifted} describedBy={describedBy} flash={lifted ? null : flash} />
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

// How long a card wears someone else's change: the ring fades over --dur-flash, the name tag a little longer.
const FLASH_MS = 2600;

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

const formatTime = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
