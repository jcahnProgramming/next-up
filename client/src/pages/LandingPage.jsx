import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './landing.css';

// The front door: one box for a board's code. Opening or creating a board isn't built yet, so the code only takes
// you to its address (/b/<code>), which says so. Nothing is looked up, created or stored here.
export const MAX_CODE = 64;

export function LandingPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const trimmed = code.trim();

  const submit = (e) => {
    e.preventDefault();
    if (trimmed) navigate(`/b/${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="landing">
      <section className="landing-sheet glass-2" aria-labelledby="landing-title">
        <h1 id="landing-title" className="landing-title display">Next Up</h1>
        <p className="landing-sub">Post Nerf Clarity's game plan. Type a board's code to open it.</p>
        <form className="code-form" onSubmit={submit}>
          <label htmlFor="board-code" className="sr-only">Board code</label>
          <input
            id="board-code"
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Board code"
            maxLength={MAX_CODE}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <button type="submit" className="code-go" disabled={!trimmed} aria-label="Open board">
            <ArrowIcon />
          </button>
        </form>
      </section>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
