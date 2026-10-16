import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from '../../chrome/icons.jsx';
import { APP_VERSION, RELEASES } from '../../release.js';
import './changelog.css';

// design/v1 Changelog.dc.html: New is accent, Improved success, Fixed warning, Removed neutral.
const SECTION_BADGE = { New: 'badge-accent', Improved: 'badge-success', Fixed: 'badge-warning' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-02" → "2 Oct 2026", read as a calendar date (no time zone can shift it a day).
function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// From home-dashboard (design/v1 Changelog.dc.html). Rendered from CHANGELOG.json, bundled with this build.
export function ChangelogPage() {
  const navigate = useNavigate();
  return (
    <div className="changelog">
      <div className="changelog-head">
        <button type="button" className="btn btn-ghost btn-sm changelog-back" onClick={() => navigate('/')}>
          <ChevronLeft />
          Home
        </button>
        <h1 className="changelog-title display">What's new</h1>
        <p className="changelog-sub">
          You're on v{APP_VERSION}. These notes come with this version of the app.
        </p>
      </div>

      {RELEASES.map((release, i) => (
        <article key={release.version} className="release" aria-labelledby={`v-${release.version}`}>
          <div className="release-meta">
            <div className="release-version-row">
              <h2 id={`v-${release.version}`} className="release-version">v{release.version}</h2>
              {i === 0 && <span className="badge badge-accent">Installed</span>}
            </div>
            <time className="release-date" dateTime={release.date}>{formatDate(release.date)}</time>
          </div>
          <div className="release-notes">
            <p className="release-headline">{release.title}</p>
            {Object.entries(release.sections).map(([section, items]) => (
              <div key={section} className="release-group">
                <h3 className={`badge release-group-label ${SECTION_BADGE[section] ?? ''}`}>{section}</h3>
                <ul>
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
