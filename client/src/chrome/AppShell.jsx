import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { NamePromptProvider } from '../prefs/NamePrompt.jsx';
import { APP_VERSION } from '../release.js';
import { ArrowRight, CoffeeIcon, SettingsIcon } from './icons.jsx';
import { createScrollMemory, focusMainHeading, restoreScroll, scrollDecision } from './scrollMemory.js';
import { CodeChip, TopbarProvider, useTopbar } from './topbar.jsx';
import './chrome.css';

// From home-dashboard: no navigation menu, sidebar or tab bar. A top bar with the app name and one button,
// and a bottom bar with the version.
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
  const { pathname } = useLocation();
  const { board } = useTopbar();
  return (
    <div className="shell">
      <ScrollManager />
      <header className={`topbar${board ? ' has-board' : ''}`}>
        <Link to="/" className="topbar-name display" aria-label="Next Up, home">
          <span className="topbar-mark" aria-hidden="true"><ArrowRight size={16} /></span>
          <span className="topbar-word">Next Up</span>
        </Link>
        {board && (
          <>
            <span className="topbar-sep" aria-hidden="true" />
            <CodeChip board={board} />
          </>
        )}
        <div className="topbar-actions">
          <NavLink to="/settings" className="round-button" aria-label="Settings" title="Settings">
            <SettingsIcon />
          </NavLink>
        </div>
      </header>

      {/* Keyed by path so each page plays the rise-in once when you arrive. */}
      <main className="page" key={pathname}>
        <Outlet />
      </main>

      <footer className="bottombar">
        {/* Separate parts spaced by the flex gap, never by literal spaces: inside a flex box, bare text runs become
            items and lose their edge whitespace (on the design canvas it read "Next Upv0.1.0· What's new"). */}
        <NavLink to="/changelog" className="version-link" aria-label={`Next Up v${APP_VERSION}, What's new`}>
          <span>Next Up</span>
          <span className="version-number">v{APP_VERSION}</span>
          <span aria-hidden="true">·</span>
          <span>What's new</span>
        </NavLink>
      </footer>

      {/* Pinned to the bottom of the viewport on every page, separate from the version link above (which stays in
          the page and clears it through the shell's bottom padding). A plain link: no script, pixel or widget. */}
      <aside className="coffee-bar" aria-label="Support Next Up">
        <a className="coffee-link" href={COFFEE_URL} target="_blank" rel="noopener noreferrer">
          <CoffeeIcon />
          <span>Buy me a coffee</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </aside>
    </div>
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
    // The heading may render a moment later (a page that loads its data first).
    let done = false;
    const timers = [0, 150, 600].map((ms) => setTimeout(() => {
      if (!done) done = focusMainHeading(document);
    }, ms));
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
