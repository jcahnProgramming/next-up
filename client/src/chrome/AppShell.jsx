import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { SyncPill } from '../live/Live.jsx';
import { NamePromptProvider } from '../prefs/NamePrompt.jsx';
import { APP_VERSION } from '../release.js';
import { ArrowRight, CoffeeIcon, HistoryIcon, SettingsIcon } from './icons.jsx';
import { createScrollMemory, focusMainHeading, restoreScroll, scrollDecision } from './scrollMemory.js';
import { CodeChip, TopbarProvider, useTopbar } from './topbar.jsx';
import './chrome.css';

// From home-dashboard: no navigation menu, sidebar or tab bar. A sticky glass top bar with the app name and its
// buttons, and one glass strip pinned to the bottom: the version and What's new on the left, Buy me a coffee on the
// right. The page scrolls under both.
export function AppShell() {
  return (
    <TopbarProvider>
      <NamePromptProvider>
        <Shell />
      </NamePromptProvider>
    </TopbarProvider>
  );
}

function Shell() {
  const location = useLocation();
  const { pathname } = location;
  const { board } = useTopbar();
  // Settings opened from an open board shows its "This board" section (pages/settings/BoardSettings.jsx); from
  // anywhere else (the landing page, a lock screen) it doesn't. On Settings itself the button keeps what it had.
  const settingsState = board && !board.plain ? { board: board.code } : pathname === '/settings' ? location.state : null;
  return (
    <>
      <ScrollManager />
      {/* Sticky glass: the page scrolls under it. The bar spans the window; its contents line up with the page. */}
      <header className="topbar-bar">
        <div className={`topbar${board ? ' has-board' : ''}`}>
          <Link to="/" className="topbar-name display" aria-label="Next Up, home">
            <span className="topbar-mark" aria-hidden="true"><ArrowRight size={16} /></span>
            <span className="topbar-word">Next Up</span>
          </Link>
          {board && (
            <>
              <span className="topbar-sep" aria-hidden="true" />
              <CodeChip board={board} />
              {board.live && !board.plain && <SyncPill live={board.live} />}
            </>
          )}
          <div className="topbar-actions">
            {board?.onHistory && (
              <button type="button" className="round-button" onClick={board.onHistory} aria-label="History" title="History">
                <HistoryIcon />
              </button>
            )}
            <NavLink to="/settings" state={settingsState} className="round-button" aria-label="Settings" title="Settings">
              <SettingsIcon />
            </NavLink>
          </div>
        </div>
      </header>

      <div className="shell">
        {/* Keyed by path so each page plays the rise-in once when you arrive. */}
        <main className="page" key={pathname}>
          <Outlet />
        </main>
      </div>

      {/* The bottom strip, pinned to the viewport on every page (the page clears it through the shell's bottom
          padding, and scrolls under it). The version and What's new on the left, the coffee link on the right: a
          plain link, no script, pixel or widget. Parts are spaced by the flex gap, never by literal spaces: inside a
          flex box, bare text runs become items and lose their edge whitespace ("Next Upv0.1.0· What's new"). It
          keeps the class coffee-bar: drag auto-scroll measures from its top edge (cards/useCardDrag.js). */}
      <footer className="coffee-bar">
        <NavLink to="/changelog" className="version-link">
          <span className="version-name">Next Up</span>
          <span className="version-number">v{APP_VERSION}</span>
          <span aria-hidden="true">·</span>
          <span>What's new</span>
        </NavLink>
        <a className="coffee-link" href={COFFEE_URL} target="_blank" rel="noopener noreferrer">
          <CoffeeIcon />
          <span>Buy me a coffee</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </footer>
    </>
  );
}

const COFFEE_URL = 'https://buymeacoffee.com/PathPlays';

const memory = createScrollMemory();

/**
 * A new page opens at the top with its heading focused; Back / Forward return to where that page was left; the same
 * page with another query stays put (chrome/scrollMemory.js).
 */
function ScrollManager() {
  const location = useLocation();
  const navType = useNavigationType();
  const prevPath = useRef(null);

  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  }, []);

  // Remember this entry's position as the reader scrolls (not when leaving: by then the next page may have clamped it).
  useEffect(() => {
    const save = () => memory.save(location.key, window.scrollY);
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      window.removeEventListener('scroll', save);
    };
  }, [location.key]);

  useLayoutEffect(() => {
    const decision = scrollDecision({ navType, prevPath: prevPath.current, nextPath: location.pathname });
    prevPath.current = location.pathname;
    if (decision === 'stay') return undefined;
    if (decision === 'restore') return restoreScroll(window, document, memory.get(location.key) ?? 0);
    window.scrollTo(0, 0);
    // The heading may render a moment later (a page that loads its data first), and may be replaced once it has (a
    // board's "Opening…" heading, then the board's own): it follows to the new one, but only until the reader first
    // presses a key or the pointer. After that, focus is theirs.
    let heading = null;
    let touched = false;
    const touch = () => {
      touched = true;
    };
    window.addEventListener('keydown', touch, true);
    window.addEventListener('pointerdown', touch, true);
    const timers = [0, 150, 600, 1500, 3000].map((ms) => setTimeout(() => {
      if (touched) return;
      const lost = heading && !heading.isConnected && (!document.activeElement || document.activeElement === document.body);
      if (!heading || lost) heading = focusMainHeading(document) ? document.activeElement : null;
    }, ms));
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', touch, true);
      window.removeEventListener('pointerdown', touch, true);
    };
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
