import { useNavigate } from 'react-router-dom';
import './comingSoon.css';

// From home-dashboard (design/v1 ComingSoon): a centred glass sheet that says plainly the feature isn't built.
// No sample content, ever: this is the honest state until the feature ships.
export function ComingSoon({ feature, children, label = 'Coming soon', back = true }) {
  const navigate = useNavigate();
  return (
    <div className="soon">
      <section className="soon-sheet glass-2" aria-labelledby="soon-title">
        <div className="soon-dots" aria-hidden="true">
          <span />
          <span />
          <span className="soon-dot-on" />
        </div>
        <span className="soon-label">{label}</span>
        <h1 id="soon-title" className="soon-title display">{feature}</h1>
        <p className="soon-body">
          {children ?? "This part of Next Up isn't built yet. When it ships it'll appear in What's new."}
        </p>
        {back && (
          <button type="button" className="soon-back" onClick={() => navigate('/')}>
            Back to Home
          </button>
        )}
      </section>
    </div>
  );
}
