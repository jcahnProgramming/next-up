import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { boardLink } from '../boards/codes.js';
import { CheckIcon, CopyIcon, LockIcon, WarningIcon } from './icons.jsx';

/**
 * What the top bar shows about the board on screen (design/v1 Topbar-Options, option A):
 *
 *   null                              no board (landing, Settings from landing, What's new): wordmark + Settings
 *   { code, plain: true }             lock screen / not open yet: only the code as typed
 *   { code, onLock? }                 an open board: the code chip with copy-link; onLock adds the lock button
 *                                     (a password board unlocked in this browser)
 *
 * A page sets it with useTopbarBoard(); the shell renders it.
 */
const TopbarContext = createContext({ board: null, setBoard: () => {}, toast: () => {} });

export function TopbarProvider({ children }) {
  const [board, setBoard] = useState(null);
  const [message, setMessage] = useState(null);
  const toast = useCallback((text, tone = 'ok') => setMessage({ text, tone, id: Date.now() }), []);
  const dismiss = useCallback(() => setMessage(null), []);
  return (
    <TopbarContext.Provider value={{ board, setBoard, toast }}>
      {children}
      <Toast message={message} onDismiss={dismiss} />
    </TopbarContext.Provider>
  );
}

export function useTopbar() {
  return useContext(TopbarContext);
}

/** Shows `board` in the top bar while the calling page is mounted. */
export function useTopbarBoard(board) {
  const { setBoard } = useContext(TopbarContext);
  const key = board ? `${board.code}|${board.plain ? 'plain' : 'open'}|${board.onLock ? 'lock' : ''}` : '';
  const latest = useRef(board);
  latest.current = board;
  useEffect(() => {
    setBoard(latest.current);
  }, [key, setBoard]);
  useEffect(() => {
    return () => {
      setBoard(null);
    };
  }, [setBoard]);
}

export function CodeChip({ board }) {
  const { toast } = useTopbar();
  if (board.plain) {
    return (
      <span className="codechip is-plain">
        <span className="codechip-code">{board.code}</span>
      </span>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(boardLink(board.code));
      toast('Link copied');
    } catch {
      toast(`Couldn't copy. The link is ${boardLink(board.code)}`, 'error');
    }
  };
  return (
    <span className="codechip">
      <span className="codechip-code">{board.code}</span>
      <button type="button" className="icon-btn" onClick={copy} aria-label="Copy board link" title="Copy board link">
        <CopyIcon />
      </button>
      {board.onLock && (
        <button
          type="button"
          className="icon-btn lock-btn"
          onClick={board.onLock}
          aria-label="Lock this board on this browser"
          title="Lock: forget the password on this browser"
        >
          <LockIcon />
        </button>
      )}
    </span>
  );
}

// design/v1 Components "Banners and toast". Announced politely; stays 4 s, or until dismissed.
function Toast({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(onDismiss, message.tone === 'error' ? 8000 : 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [message, onDismiss]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && (
        <div className={`toast glass-2 toast-${message.tone}`} key={message.id}>
          {message.tone === 'error' ? <WarningIcon /> : <CheckIcon size={18} />}
          <span className="toast-text">{message.text}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
