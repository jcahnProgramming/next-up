import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { APP_VERSION } from '../release.js';
import { ArrowRight, SettingsIcon } from './icons.jsx';
import { createScrollMemory, focusMainHeading, restoreScroll, scrollDecision } from './scrollMemory.js';
import './chrome.css';

// From home-dashboard: no navigation menu, sidebar or tab bar. A top bar with the app name and one button,
// and a bottom bar with the version.
export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <ScrollManager />
      <header className="topbar">
        <Link to="/" className="topbar-name display">
          <span className="topbar-mark" aria-hidden="true"><ArrowRight size={16} /></span>
          Next Up
        </Link>
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
    </div>
  );
}

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
