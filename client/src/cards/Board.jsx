import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlusIcon, RetryIcon, WarningIcon } from '../chrome/icons.jsx';
import { useTopbar } from '../chrome/topbar.jsx';
import { useOnline } from '../chrome/useOnline.js';
import { useAskName } from '../prefs/NamePrompt.jsx';
import { LANES, MAX_CARDS, laneName } from '../../../server/core/cardRules.js';
import { addCard, deleteCard, editCard, loadCards } from './api.js';
import { CardPill } from './Card.jsx';
import { CardEditor, CardPanel, ConfirmDelete } from './CardSheets.jsx';
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
 */
export function Board({ board, onLocked }) {
  const code = board.code;
  const { toast } = useTopbar();
  const askName = useAskName();
  const online = useOnline();
  const [load, setLoad] = useState({ kind: 'loading' });
  const [data, setData] = useState(null); // { cards, limit, loadedAt }
  const [sheet, setSheet] = useState(null); // { mode: 'view' | 'edit' | 'add' | 'delete', id?, lane?, back? }
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

      <div className={`lanes${paused ? ' is-stale' : ''}`}>
        {LANES.map((lane) => (
          <Lane
            key={lane.id}
            lane={lane}
            cards={lanes[lane.id]}
            boardEmpty={empty}
            canAdd={!paused && !full}
            onAdd={() => openAdd(lane.id)}
            onOpen={open}
          />
        ))}
      </div>

      {sheet?.mode === 'view' && sheetCard && (
        <CardPanel
          card={sheetCard}
          paused={paused}
          onEdit={() => setSheet({ mode: 'edit', id: sheetCard.id, back: 'view' })}
          onDelete={() => setSheet({ mode: 'delete', id: sheetCard.id, back: 'view' })}
          onClose={() => setSheet(null)}
        />
      )}
      {(sheet?.mode === 'add' || (sheet?.mode === 'edit' && sheetCard)) && (
        <CardEditor
          key={sheet.mode === 'add' ? 'add' : `edit-${sheet.id}`}
          card={sheet.mode === 'edit' ? sheetCard : null}
          lane={sheet.lane}
          paused={paused}
          full={full}
          onSave={(values) => save(sheet.mode, sheetCard, values)}
          onDelete={() => setSheet({ mode: 'delete', id: sheetCard.id, back: 'edit' })}
          onClose={() => setSheet(sheet.back === 'view' ? { mode: 'view', id: sheet.id } : null)}
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

function Lane({ lane, cards, boardEmpty, canAdd, onAdd, onOpen }) {
  const headId = `lane-${lane.id}`;
  const n = cards.length;
  return (
    <section className="lane glass-1" aria-labelledby={headId}>
      <div className="lane-head">
        <span className={`lane-dot ld-${lane.id}`} aria-hidden="true" />
        <h2 id={headId} className="lane-name">
          {lane.name}
        </h2>
        <span className="lane-n" aria-label={n === 1 ? '1 game' : `${n} games`}>
          {n}
        </span>
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
      ) : n === 0 ? (
        <div className="lane-empty">{EMPTY[lane.id]}</div>
      ) : (
        <ol className="lane-cards">
          {cards.map((card) => (
            <li key={card.id}>
              <CardPill card={card} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </section>
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
