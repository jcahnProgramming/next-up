import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckIcon, LockIcon, WarningIcon } from '../chrome/icons.jsx';
import { useTopbar, useTopbarBoard } from '../chrome/topbar.jsx';
import { lockBoard, lookupBoard } from '../boards/api.js';
import { checkCode } from '../boards/codes.js';
import { CreateBoard } from '../boards/CreateBoard.jsx';
import { LockScreen } from '../boards/LockScreen.jsx';
import { BoardLimit, TooManyLookups } from '../boards/states.jsx';
import '../boards/boards.css';

// /b/:code. Looks the code up and shows exactly one of:
//   opening · the board (lanes and cards are not built yet, and it says so) · lock screen · "free: create it?" ·
//   board limit reached · too many lookups · not a code · couldn't load (with Retry)
export function BoardPage() {
  const { code: raw } = useParams();
  const navigate = useNavigate();
  const parsed = checkCode(raw);
  const code = parsed.ok ? parsed.code : null;
  const [state, setState] = useState({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // /b/PNC-Raids → /b/pnc-raids: one address per board.
  useEffect(() => {
    if (code && raw !== code) navigate(`/b/${code}`, { replace: true });
  }, [code, raw, navigate]);

  useEffect(() => {
    if (!code) return undefined;
    let live = true;
    setState({ kind: 'loading' });
    lookupBoard(code).then((result) => {
      if (live) setState(result);
    });
    return () => {
      live = false;
    };
  }, [code, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (!code) return <NotACode raw={raw} error={parsed.error} />;
  return <BoardView code={code} state={state} setState={setState} retry={retry} />;
}

function BoardView({ code, state, setState, retry }) {
  const navigate = useNavigate();
  const { toast } = useTopbar();

  const relock = useCallback(async () => {
    const result = await lockBoard(code);
    if (result.kind === 'done') {
      setState({ kind: 'locked', changed: false });
      toast('Locked on this browser');
    } else {
      toast("Couldn't lock it: Next Up couldn't be reached. This browser still has access.", 'error');
    }
  }, [code, setState, toast]);

  const open = state.kind === 'open';
  useTopbarBoard({ code, plain: !open, onLock: open && state.board.hasPassword ? relock : undefined });

  switch (state.kind) {
    case 'loading':
      return (
        <Centered>
          <div className="board-loading" aria-live="polite">
            <span className="spin" aria-hidden="true" />
            <h1 className="board-loading-text">
              Opening <span className="code-text">{code}</span>…
            </h1>
          </div>
        </Centered>
      );
    case 'open':
      return <BoardStub board={state.board} />;
    case 'locked':
      return (
        <Centered>
          <LockScreen
            key={state.changed ? 'changed' : 'locked'}
            code={code}
            changed={state.changed}
            onUnlocked={(board) => setState({ kind: 'open', board })}
            onLookupLimited={(retryAfter) => setState({ kind: 'limited', retryAfter })}
          />
        </Centered>
      );
    case 'free':
      if (state.full) return <Full code={code} />;
      return (
        <Centered>
          <div className="board-create">
            <CreateBoard
              code={code}
              heading="h1"
              onBack={() => navigate('/')}
              onCreated={(board) => setState({ kind: 'open', board })}
              onLimited={(retryAfter) => setState({ kind: 'limited', retryAfter })}
              onFull={() => setState({ kind: 'free', full: true })}
              onTaken={retry}
            />
          </div>
        </Centered>
      );
    case 'limited':
      return (
        <Centered>
          <section className="access-sheet glass-2">
            <TooManyLookups retryAfter={state.retryAfter} onDone={retry} heading="h1">
              <HomeButton />
            </TooManyLookups>
          </section>
        </Centered>
      );
    default:
      return (
        <Centered>
          <section className="st-error board-error" role="alert">
            <span className="icon-circle icon-circle-sm ic-err">
              <WarningIcon />
            </span>
            <h1 className="display access-title">{state.offline ? "You're offline" : "Couldn't load this board"}</h1>
            <p className="access-text">
              {state.offline
                ? 'Boards need a connection to open.'
                : 'Next Up didn’t answer. Nothing has changed on the board; this is only about reaching it.'}
            </p>
            <div className="access-actions">
              <button type="button" className="btn btn-primary" onClick={retry}>
                Retry
              </button>
            </div>
          </section>
        </Centered>
      );
  }
}

// The board itself is the next piece of work. Until it ships, this says so plainly and shows only what is real.
function BoardStub({ board }) {
  const created = new Date(board.createdAt);
  return (
    <Centered>
      <section className="access-sheet glass-2 board-stub" aria-labelledby="board-title">
        <span className="icon-circle ic-ok">
          {board.hasPassword ? <LockIcon size={24} open /> : <CheckIcon size={24} />}
        </span>
        <h1 id="board-title" className="display access-title">
          <span className="code-text">{board.code}</span> is open
        </h1>
        <p className="access-text">
          Lanes and cards are coming soon. This board exists and is saved, but Next Up can’t show or add games yet, so
          there’s nothing here to see.
        </p>
        <ul className="board-facts">
          <li>
            <span className="badge">{board.hasPassword ? 'Password board' : 'Open board'}</span>
            {board.hasPassword
              ? 'Unlocked in this browser. The lock on the code chip forgets it here.'
              : 'Anyone with the code can open and edit it.'}
          </li>
          {!Number.isNaN(created.getTime()) && (
            <li>
              <span className="badge">Created</span>
              <time dateTime={board.createdAt}>
                {created.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
              </time>
            </li>
          )}
        </ul>
        <HomeButton secondary />
      </section>
    </Centered>
  );
}

function Full({ code }) {
  const navigate = useNavigate();
  return (
    <Centered>
      <section className="access-sheet glass-2">
        <BoardLimit code={code} heading="h1" onBack={() => navigate('/')} />
      </section>
    </Centered>
  );
}

function NotACode({ raw, error }) {
  useTopbarBoard(null);
  return (
    <Centered>
      <section className="access-sheet glass-2" role="alert">
        <span className="icon-circle ic-neutral">
          <WarningIcon />
        </span>
        <h1 className="display access-title">That isn’t a board code</h1>
        <p className="access-text">
          <span className="code-text">{raw}</span> can’t be a board. {error}
        </p>
        <HomeButton />
      </section>
    </Centered>
  );
}

function HomeButton({ secondary = false }) {
  const navigate = useNavigate();
  return (
    <div className="access-actions">
      <button type="button" className={`btn ${secondary ? 'btn-quiet' : 'btn-secondary'}`} onClick={() => navigate('/')}>
        Back to Home
      </button>
    </div>
  );
}

function Centered({ children }) {
  return <div className="board-center">{children}</div>;
}
