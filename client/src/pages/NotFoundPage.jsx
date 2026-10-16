import { useNavigate } from 'react-router-dom';
import './notFound.css';

// A centred glass sheet (from home-dashboard's design) for an address with no page.
export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="soon">
      <section className="soon-sheet glass-2" aria-labelledby="soon-title">
        <div className="soon-dots" aria-hidden="true">
          <span />
          <span />
          <span className="soon-dot-on" />
        </div>
        <span className="soon-label">Not found</span>
        <h1 id="soon-title" className="soon-title display">Page not found</h1>
        <p className="soon-body">There&rsquo;s no page at this address.</p>
        <button type="button" className="btn btn-secondary soon-back" onClick={() => navigate('/')}>
          Back to Home
        </button>
      </section>
    </div>
  );
}
