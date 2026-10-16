import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { WarningIcon } from '../chrome/icons.jsx';
import { connectLive } from './connection.js';
import { TAB_ID } from './tab.js';
import './live.css';

/**
 * Live sync on the page: the stream's hook, the context the board's sheets read it from, the sync pill (design/v1
 * Components "Live sync", Topbar-Options) and the banners (Components "Banners", Board-States, Board-Phone-States).
 *
 *   useLive({ code, head, onChange, onReset, onLocked, onBoard, onGone }) → { status, why, since, retry }
 *     head: the event id the board was loaded at (null until it has loaded: nothing connects before that)
 *   <LiveContext.Provider value={{ ...live, deleting, subscribe }}>   subscribe(fn) → unsubscribe: every change
 *     applied, in order; deleting: the board is being deleted (boards/Deletion.jsx), which pauses editing too
 *   usePaused()  true unless live and not being deleted: editing pauses everywhere until the stream is caught up and
 *     hearing from Next Up, and while the board is being deleted
 */
export function useLive({ code, head, onChange, onReset, onLocked, onBoard, onGone }) {
  const [state, setState] = useState({ status: 'connecting', why: null, since: null });
  const conn = useRef(null);
  const latest = useRef({ onChange, onReset, onLocked, onBoard, onGone });
  latest.current = { onChange, onReset, onLocked, onBoard, onGone };
  const started = head !== null;

  useEffect(() => {
    if (!started) return undefined;
    const c = connectLive({
      code,
      since: head,
      tab: TAB_ID,
      onStatus: setState,
      onChange: (data, id) => latest.current.onChange(data, id),
      onReset: () => latest.current.onReset(),
      onLocked: (changed) => latest.current.onLocked(changed),
      onBoard: (board) => latest.current.onBoard?.(board),
      onGone: () => latest.current.onGone?.(),
    });
    conn.current = c;
    // Back online, or the page shown again after sleep: catch up now rather than at the next backoff.
    const online = () => c.retry();
    const offline = () => c.retry(); // says offline at once, rather than when the line next goes quiet
    const shown = () => {
      if (!document.hidden) c.check();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('pageshow', shown);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('pageshow', shown);
      c.close();
      conn.current = null;
    };
    // head is only where it starts; later loads don't restart it (the stream is ahead of them, or level).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, started]);

  return { ...state, retry: () => conn.current?.retry() };
}

// Outside a board's provider nothing is live: editing stays paused rather than assumed safe.
export const LiveContext = createContext({ status: 'connecting', why: null, since: null, deleting: false, retry: () => {}, subscribe: () => () => {} });

export const useLiveState = () => useContext(LiveContext);
export const usePaused = () => {
  const { status, deleting } = useContext(LiveContext);
  return status !== 'live' || deleting;
};

/** Calls fn(message) for every live change the board applies while the caller is mounted ({ reset: true } on a reload). */
export function useLiveChanges(fn) {
  const { subscribe } = useContext(LiveContext);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    return subscribe((m) => latest.current(m));
  }, [subscribe]);
}

const time = (d) => (d ? new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');

/** The top bar's sync pill. On a phone it folds down to its dot or icon, with the words kept for screen readers. */
export function SyncPill({ live }) {
  const { status, since } = live;
  const [cls, icon, label] = {
    connecting: ['sync-lock', <span key="s" className="spin" aria-hidden="true" />, 'Connecting…'],
    live: ['sync-live', <span key="d" className="dot dot-pulse" aria-hidden="true" />, 'Live'],
    reconnecting: ['sync-re', <span key="s" className="spin" aria-hidden="true" />, 'Reconnecting…'],
    offline: ['sync-off', <OfflineIcon key="o" size={14} />, `Offline · as of ${time(since)}`],
    down: ['sync-off', <OfflineIcon key="o" size={14} />, `Not connected · as of ${time(since)}`],
    // Connected, but a reload failed: the board shown is out of date (cards/Board.jsx).
    behind: ['sync-off', <OfflineIcon key="o" size={14} />, `Out of date · as of ${time(since)}`],
  }[status];
  return (
    <span className={`sync ${cls}`} role="status" title={label}>
      {icon}
      <span className="sync-label">{label}</span>
    </span>
  );
}

/**
 * The board's banner while it isn't live: what's wrong, how old the board is, that editing is paused, and Retry
 * (which reconnects now). Nothing while live or still making the first connection.
 */
export function SyncBanner({ live, loadedAt }) {
  const { status, why, since, retry } = live;
  if (status === 'live' || status === 'connecting') return null;
  const asOf = time(since ?? loadedAt);
  const [tone, icon, text] = {
    reconnecting:
      why === 'busy'
        ? ['banner-warn', <span key="s" className="spin" aria-hidden="true" />, <><b>Next Up is busy.</b> Too many live connections from your network or to this board right now. Editing paused until we reconnect.</>]
        : ['banner-warn', <span key="s" className="spin" aria-hidden="true" />, <><b>Reconnecting…</b> Changes from others will appear when we’re back. Editing paused until we reconnect.</>]
    ,
    offline: ['banner-err', <OfflineIcon key="o" />, <><b>You’re offline.</b> Showing the board as it was at {asOf}. Editing paused until we reconnect.</>],
    down: ['banner-err', <WarningIcon key="w" />, <><b>Not connected.</b> Next Up isn’t answering. Showing the board as it was at {asOf}. Editing paused until we reconnect.</>],
  }[status];
  return (
    <div className={`banner ${tone} board-banner`} role="status">
      {icon}
      <span className="banner-text">{text}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

/**
 * "Editing paused until we reconnect." with Retry, inside a sheet, wherever editing is paused (CLAUDE.md). While the
 * board is being deleted (and connected), it says that instead: reconnecting wouldn't help, restoring the board would.
 */
export function PausedBanner() {
  const { status, why, since, retry, deleting } = useLiveState();
  if (deleting && status === 'live') {
    return (
      <div className="banner banner-warn" role="status">
        <WarningIcon />
        <span className="banner-text">
          <b>This board is being deleted.</b> Editing is paused until someone restores it.
        </span>
      </div>
    );
  }
  if (status === 'behind') {
    return (
      <div className="banner banner-err" role="status">
        <WarningIcon />
        <span className="banner-text">
          <b>Couldn’t refresh the board.</b> Editing paused until it loads.
        </span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  const solid = status === 'offline' || status === 'down';
  const lead = status === 'offline' ? 'You’re offline.' : status === 'down' ? 'Not connected.' : why === 'busy' ? 'Next Up is busy.' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <div className={`banner ${solid ? 'banner-err' : 'banner-warn'}`} role="status">
      {solid ? <WarningIcon /> : <span className="spin" aria-hidden="true" />}
      <span className="banner-text">
        <b>{lead}</b>
        {solid && since ? ` As of ${time(since)}.` : ''} Editing paused until we reconnect.
      </span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

export function OfflineIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M2 8.5a15 15 0 0 1 5-3M22 8.5a15 15 0 0 0-11-3.9M9 15.5a5 5 0 0 1 6 0M3 3l18 18" />
    </svg>
  );
}

/** "Bunzato moved this": the live-update name tag's words for a change (design/v1 Card-States). */
export function tagOf({ entry, player }) {
  const { verb, subject, tag } = entry.line;
  if (tag) return `${entry.actor} ${tag}`;
  if (player) return `${entry.actor} ${verb} ${subject}`;
  return `${entry.actor} ${verb} this`;
}

/** The sentence a screen reader hears for a change someone else made: History's line. */
export function sentenceOf({ entry }) {
  const { verb, subject, detail } = entry.line;
  return `${entry.actor} ${verb} ${subject}${detail}`.replace(/\s+/g, ' ').trim();
}
