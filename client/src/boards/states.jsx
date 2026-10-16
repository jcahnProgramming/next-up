import { ClockIcon, FullIcon } from '../chrome/icons.jsx';
import { formatCountdown, useCountdown } from './useCountdown.js';

/** The rate-limit countdown badge (design/v1 Components): one size wherever it appears. */
export function Countdown({ retryAfter, onDone }) {
  const left = useCountdown(retryAfter, onDone);
  return (
    <span className="badge badge-warning badge-countdown" role="timer" aria-live="off">
      Try again in {formatCountdown(left)}
    </span>
  );
}

/** "Too many tries for now" for unknown codes (Landing-States 4 / Landing-Phone). */
export function TooManyLookups({ retryAfter, onDone, heading: H = 'h2', children }) {
  return (
    <div className="access-state" role="alert">
      <span className="icon-circle ic-warn">
        <ClockIcon />
      </span>
      <H className="display access-title">Too many tries for now</H>
      <p className="access-text">
        Your network has tried a lot of codes that don’t exist. You can try again in a few minutes; boards you’ve opened
        before in this browser still open by their link.
      </p>
      <Countdown retryAfter={retryAfter} onDone={onDone} />
      {children}
    </div>
  );
}

/** "Next Up is full" (Landing-States 5): the code is free but the board cap is reached. */
export function BoardLimit({ code, onBack, heading: H = 'h2', backLabel = 'Try another code' }) {
  return (
    <div className="access-state" role="alert">
      <span className="icon-circle ic-neutral">
        <FullIcon />
      </span>
      <H className="display access-title">Next Up is full</H>
      <p className="access-text">
        <span className="code-text">{code}</span> is free, but Next Up has reached its limit on boards, so it can’t make
        new ones right now. Opening an existing board still works.
      </p>
      <div className="access-actions">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          {backLabel}
        </button>
      </div>
    </div>
  );
}
