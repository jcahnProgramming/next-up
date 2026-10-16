import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LANES, laneName } from '../../../server/core/cardRules.js';

/**
 * Moving cards: drag and drop with a mouse or pen, long-press and drag on a touch screen, and Space / arrows / Space
 * from the keyboard (design/v1 Card-States, Board-Desktop, Board-Phone). Native pointer events, no library.
 *
 *   const dnd = useCardDrag({ enabled, lanes, rootRef, onDrop, announce });
 *   dnd.drag      null, or { id, mode: 'pointer' | 'keyboard', touch, from, to, scrolling }; from / to are
 *                 { lane, index }, index counted among the lane's OTHER cards (0 = top)
 *   dnd.settling  true for the frame after a drop, while the lanes take their new order without animating
 *   dnd.onPointerDown(e, card) / dnd.onKeyDown(e, card) → true if it handled the key
 *   dnd.cancel()  ends a drag as Escape would (live sync: someone else deleted the card being held)
 *
 * CLAUDE.md "Bugs that cost us": the dragged node never moves in the DOM during a drag. The board draws the drag
 * from `drag` with transforms only (neighbours slide by whole card pitches, the slot is absolutely placed), the
 * dragged card's <li> follows the pointer through an inline transform set here, and the real order changes only on
 * drop. End-of-drag listeners live on window/document, and every way a drag can end goes through end(): release,
 * pointercancel, lost capture, window blur, a hidden page, a context menu (mouse), Escape, an exception in any
 * handler, or the watchdog finding the card gone.
 *
 * Touch: a press only lifts after LONG_PRESS_MS without moving more than TOUCH_SLOP; moving sooner is a scroll and
 * the drag never starts. Once lifted, touchmove is cancelled so the page doesn't scroll under the finger, and the
 * page auto-scrolls instead when the card is held near the top or bottom edge (above the coffee bar).
 */
const LONG_PRESS_MS = 350;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 5;
const MAX_SCROLL = 20; // px per frame, at the very edge
const WATCHDOG_MS = 500;

export function useCardDrag({ enabled, lanes, rootRef, onDrop, announce }) {
  const [drag, setDrag] = useState(null);
  const [settling, setSettling] = useState(false);
  const latest = useRef(null);
  latest.current = { enabled, lanes, onDrop, announce };
  const session = useRef(null);
  const flip = useRef(null);

  const othersIn = (lane, id) => (latest.current.lanes[lane] ?? []).filter((c) => c.id !== id);
  const placeOf = (id) => {
    for (const { id: lane } of LANES) {
      const index = (latest.current.lanes[lane] ?? []).findIndex((c) => c.id === id);
      if (index !== -1) return { lane, index };
    }
    return null;
  };
  const where = (to, id) => `${laneName(to.lane)}, position ${to.index + 1} of ${othersIn(to.lane, id).length + 1}`;

  // ---- ending: the one way out ----
  const end = useCallback((s, how) => {
    if (session.current !== s) return;
    session.current = null;
    s.detach?.();
    clearTimeout(s.timer);
    clearInterval(s.watchdog);
    cancelAnimationFrame(s.raf);
    document.documentElement.classList.remove('is-card-dragging');
    if (s.phase !== 'active') return;

    const { card, from, to, li } = s;
    const say = latest.current.announce;
    if (s.mode === 'pointer') {
      // Ended with the button perhaps still held (Escape, a blur): let go of the card now, and swallow the click that
      // its release will still produce, whenever that comes, so it doesn't open the card.
      try {
        if (s.el.hasPointerCapture(s.pointerId)) s.el.releasePointerCapture(s.pointerId);
      } catch {
        // the pointer is already gone
      }
      swallowClickAfterRelease(s.pointerId, how === 'drop');
    }
    const moved = how === 'drop' && (to.lane !== from.lane || to.index !== from.index);
    if (!moved) {
      // Back to where it was: the neighbours slide home on their own; the card glides back.
      if (li.isConnected) {
        li.style.transition = 'transform var(--dur-base) var(--spring)';
        li.style.transform = '';
        settleTransition(li);
      }
      setDrag(null);
      say(how === 'drop' ? `Dropped ${card.title} back where it was. ${where(from, card.id)}.` : `Cancelled. ${card.title} is back in ${where(from, card.id)}.`);
      return;
    }
    // Moved: remember where the card is on screen, let the board re-order for real (without animating the
    // neighbours, which are already drawn where they'll end up), then glide the card from here into its new place.
    flip.current = { id: card.id, rect: li.getBoundingClientRect(), focus: s.mode === 'keyboard' };
    li.style.transition = '';
    li.style.transform = '';
    say(`Dropped ${card.title}. ${where(to, card.id)}.`);
    setSettling(true);
    setDrag(null);
    latest.current.onDrop(card, to, s.mode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Any exception inside a drag handler ends the drag, cleaned up, instead of wedging the board.
  const guard = useCallback(
    (s, fn) => {
      try {
        fn();
      } catch (err) {
        console.error('Next Up: a drag failed and was cancelled', err);
        if (s.li?.isConnected) s.li.style.transform = '';
        end(s, 'cancel');
      }
    },
    [end],
  );

  const lift = (s) => {
    s.from = placeOf(s.card.id);
    if (!s.from) throw new Error('the card being lifted is not on the board');
    s.to = s.from;
    s.dx = 0;
    s.dy = 0;
    s.phase = 'active';
    document.documentElement.classList.add('is-card-dragging');
    s.watchdog = setInterval(() => guard(s, () => {
      if (!s.el.isConnected) end(s, 'cancel');
    }), WATCHDOG_MS);
    setDrag({ id: s.card.id, mode: s.mode, touch: s.touch, from: s.from, to: s.to, scrolling: null });
    const how = s.mode === 'keyboard' ? ' Arrow keys move it, Space drops it, Escape cancels.' : '';
    latest.current.announce(`Lifted ${s.card.title}. ${where(s.from, s.card.id)}.${how}`);
  };

  const retarget = (s, to) => {
    if (to.lane === s.to.lane && to.index === s.to.index) return;
    s.to = to;
    setDrag((d) => (d ? { ...d, to } : d));
    if (s.mode === 'keyboard') latest.current.announce(`${where(to, s.card.id)}.`);
  };

  // ---- pointer ----
  const hitTest = (s) => {
    const root = rootRef.current;
    let best = null;
    for (const el of root.querySelectorAll('[data-drop-lane]')) {
      const r = el.getBoundingClientRect();
      const dx = s.x < r.left ? r.left - s.x : s.x > r.right ? s.x - r.right : 0;
      const dy = s.y < r.top ? r.top - s.y : s.y > r.bottom ? s.y - r.bottom : 0;
      const d = dx * dx + dy * dy;
      if (!best || d < best.d) best = { el, d };
    }
    const lane = best.el.dataset.dropLane;
    const n = othersIn(lane, s.card.id).length;
    const list = best.el.querySelector('[data-lane-list]');
    if (!list || n === 0) return { lane, index: 0 };
    // The slot goes where the card's top edge is nearest a card boundary. Positions are the undisturbed list's:
    // `top + i × pitch` for the i-th other card, which is how the board draws them during a drag.
    const top = list.getBoundingClientRect().top;
    return { lane, index: Math.max(0, Math.min(n, Math.round((s.y - s.offY - top) / s.pitch))) };
  };

  const scrollSpeed = (y) => {
    const zone = autoscrollZone();
    const bottom = window.innerHeight - coffeeBarHeight();
    if (y < zone) return -MAX_SCROLL * Math.min(1, (zone - y) / zone);
    if (y > bottom - zone) return MAX_SCROLL * Math.min(1, (y - (bottom - zone)) / zone);
    return 0;
  };

  const step = (s) => {
    // Follow the pointer: the <li>'s layout box never moves, so its offset is measured from there.
    const r = s.li.getBoundingClientRect();
    const baseLeft = r.left - s.dx;
    const baseTop = r.top - s.dy;
    s.dx = s.x - s.offX - baseLeft;
    s.dy = s.y - s.offY - baseTop;
    s.li.style.transform = `translate3d(${s.dx}px, ${s.dy}px, 0)`;
    retarget(s, hitTest(s));

    const v = scrollSpeed(s.y);
    const before = window.scrollY;
    if (v) window.scrollBy(0, v);
    const scrolling = window.scrollY !== before ? (v > 0 ? 'down' : 'up') : null;
    if (scrolling !== s.scrolling) {
      s.scrolling = scrolling;
      setDrag((d) => (d ? { ...d, scrolling } : d));
    }
    if (scrolling) frame(s); // keep scrolling while the card is held at the edge
  };

  const frame = (s) => {
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      if (session.current === s && s.phase === 'active') guard(s, () => step(s));
    });
  };

  const startPointer = (s) => {
    const r = s.li.getBoundingClientRect();
    s.offX = s.x0 - r.left;
    s.offY = s.y0 - r.top;
    const list = s.li.parentElement;
    s.pitch = r.height + (parseFloat(getComputedStyle(list).rowGap) || 0);
    try {
      s.el.setPointerCapture(s.pointerId);
    } catch {
      // the pointer is already gone; pointerup / pointercancel will end it
    }
    lift(s);
    frame(s);
  };

  const attachPointer = (s) => {
    const mine = (e) => e.pointerId === s.pointerId;
    const on = {
      pointermove: (e) => {
        if (!mine(e)) return;
        s.x = e.clientX;
        s.y = e.clientY;
        if (s.phase === 'pending') {
          const dist = Math.hypot(s.x - s.x0, s.y - s.y0);
          if (s.touch && dist > TOUCH_SLOP) end(s, 'cancel'); // it's a scroll
          else if (!s.touch && e.buttons === 0) end(s, 'cancel'); // released outside the window
          else if (!s.touch && dist > MOUSE_SLOP) startPointer(s);
          return;
        }
        if (!s.touch && e.buttons === 0) return end(s, 'drop');
        frame(s);
        return undefined;
      },
      pointerup: (e) => mine(e) && end(s, 'drop'),
      pointercancel: (e) => mine(e) && end(s, 'cancel'),
      lostpointercapture: (e) => mine(e) && e.target === s.el && end(s, 'cancel'),
      contextmenu: (e) => {
        // A long-press on a touch screen raises the context menu; that press is ours. With a mouse it's a real
        // menu, which swallows the release, so the drag ends here.
        if (s.touch) e.preventDefault();
        else if (s.phase === 'active') end(s, 'cancel');
      },
      touchmove: (e) => {
        if (s.phase === 'active' && e.cancelable) e.preventDefault();
      },
      keydown: (e) => {
        if (e.key !== 'Escape' || s.phase !== 'active') return;
        e.preventDefault();
        e.stopPropagation();
        end(s, 'cancel');
      },
      blur: (e) => e.target === window && end(s, 'cancel'), // the window, not an element inside it
      visibilitychange: () => document.hidden && end(s, 'cancel'),
    };
    const wrapped = Object.fromEntries(Object.entries(on).map(([k, fn]) => [k, (e) => guard(s, () => fn(e))]));
    const opts = { capture: true, passive: false };
    for (const k of ['pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'touchmove', 'keydown', 'blur']) {
      window.addEventListener(k, wrapped[k], opts);
    }
    document.addEventListener('lostpointercapture', wrapped.lostpointercapture, true);
    document.addEventListener('visibilitychange', wrapped.visibilitychange);
    s.detach = () => {
      for (const k of ['pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'touchmove', 'keydown', 'blur']) {
        window.removeEventListener(k, wrapped[k], opts);
      }
      document.removeEventListener('lostpointercapture', wrapped.lostpointercapture, true);
      document.removeEventListener('visibilitychange', wrapped.visibilitychange);
    };
  };

  const onPointerDown = (e, card) => {
    if (!latest.current.enabled || session.current || e.button !== 0 || !e.isPrimary) return;
    const el = e.currentTarget;
    const s = {
      card,
      el,
      li: el.closest('li'),
      mode: 'pointer',
      touch: e.pointerType === 'touch',
      pointerId: e.pointerId,
      phase: 'pending',
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
    };
    session.current = s;
    attachPointer(s);
    if (s.touch) s.timer = setTimeout(() => guard(s, () => session.current === s && startPointer(s)), LONG_PRESS_MS);
  };

  // ---- keyboard ----
  const onKeyDown = (e, card) => {
    const s = session.current;
    if (!s) {
      if (e.key !== ' ' || e.repeat || !latest.current.enabled) return false;
      e.preventDefault();
      const k = { card, el: e.currentTarget, li: e.currentTarget.closest('li'), mode: 'keyboard', touch: false, phase: 'pending' };
      session.current = k;
      const blur = () => guard(k, () => end(k, 'cancel'));
      const hidden = () => document.hidden && blur();
      k.el.addEventListener('focusout', blur);
      window.addEventListener('blur', blur);
      document.addEventListener('visibilitychange', hidden);
      k.detach = () => {
        k.el.removeEventListener('focusout', blur);
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', hidden);
      };
      guard(k, () => lift(k));
      return true;
    }
    if (s.mode !== 'keyboard' || s.card.id !== card.id) {
      // A pointer drag is in progress: keys on cards do nothing meanwhile (Escape is handled on window).
      if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
      return e.key === ' ' || e.key === 'Enter';
    }
    guard(s, () => {
      const lane = LANES.findIndex((l) => l.id === s.to.lane);
      const count = (id) => othersIn(id, card.id).length;
      // At an edge nothing moves; say so rather than repeating the place.
      const stuck = (why) => latest.current.announce(`${where(s.to, card.id)}. ${why}`);
      switch (e.key) {
        case 'ArrowUp':
          if (s.to.index === 0) stuck('That’s the top of the lane.');
          else retarget(s, { lane: s.to.lane, index: s.to.index - 1 });
          break;
        case 'ArrowDown':
          if (s.to.index >= count(s.to.lane)) stuck('That’s the bottom of the lane.');
          else retarget(s, { lane: s.to.lane, index: s.to.index + 1 });
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const next = LANES[lane + (e.key === 'ArrowLeft' ? -1 : 1)];
          if (next) retarget(s, { lane: next.id, index: Math.min(count(next.id), s.to.index) });
          else stuck(e.key === 'ArrowLeft' ? 'That’s the first lane.' : 'That’s the last lane.');
          break;
        }
        case ' ':
        case 'Enter':
          if (!e.repeat) end(s, 'drop');
          break;
        case 'Escape':
          e.stopPropagation();
          end(s, 'cancel');
          break;
        default:
          return;
      }
      e.preventDefault();
    });
    return true;
  };

  // Keyboard: the lifted card sits over its slot, wherever the arrows have put it, and stays in view. Pointer: a new
  // target can change the layout under a still pointer (stacked lanes grow and shrink), so follow it again.
  useLayoutEffect(() => {
    const s = session.current;
    if (!drag || !s || s.phase !== 'active') return;
    if (drag.mode === 'pointer') {
      frame(s);
      return;
    }
    guard(s, () => {
      const slot = rootRef.current.querySelector('[data-slot]');
      if (!slot) return;
      const r = s.li.getBoundingClientRect();
      const to = slot.getBoundingClientRect();
      s.dx = to.left - (r.left - s.dx);
      s.dy = to.top - (r.top - s.dy);
      s.li.style.transition = 'transform var(--dur-base) var(--spring)';
      s.li.style.transform = `translate3d(${s.dx}px, ${s.dy}px, 0)`;
      slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [drag, guard, rootRef]);

  // After a drop: glide the card from where it was let go into its new place, then let the lanes animate again.
  useLayoutEffect(() => {
    const f = flip.current;
    if (!f || drag) return undefined;
    flip.current = null;
    const card = rootRef.current?.querySelector(`[data-card-id="${f.id}"]`);
    const li = card?.closest('li');
    if (li) {
      const r = li.getBoundingClientRect();
      li.style.transition = 'none';
      li.style.transform = `translate3d(${f.rect.left - r.left}px, ${f.rect.top - r.top}px, 0)`;
      li.getBoundingClientRect(); // commit the starting point before animating from it
      li.style.transition = 'transform var(--dur-base) var(--spring)';
      li.style.transform = '';
      settleTransition(li);
      if (f.focus) {
        card.focus({ preventScroll: true });
        card.scrollIntoView({ block: 'nearest' });
      }
    }
    const raf = requestAnimationFrame(() => setSettling(false));
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [drag, settling, rootRef]);

  // Leaving the board mid-drag (navigation, the board locking) ends it cleanly.
  useEffect(() => {
    return () => {
      if (session.current) end(session.current, 'cancel');
    };
  }, [end]);

  const cancel = useCallback(() => {
    if (session.current) end(session.current, 'cancel');
  }, [end]);

  return { drag, settling, onPointerDown, onKeyDown, cancel };
}

// The auto-scroll band's height (--autoscroll-zone), read once.
let zone = null;
function autoscrollZone() {
  if (zone === null) zone = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--autoscroll-zone')) || 96;
  return zone;
}

// Auto-scroll measures from the coffee bar's top edge: the bar covers the bottom of the viewport.
function coffeeBarHeight() {
  return document.querySelector('.coffee-bar')?.getBoundingClientRect().height ?? 0;
}

// A pointer drag's release is followed by a click: that click is the drop (or the end of a cancelled drag), not "open
// the card". `released`: the pointer is already up, so the click is due now; otherwise it comes after the release,
// however late (a drag cancelled by Escape with the button still held). A new press means that release was lost
// (let go outside the window), and nothing is swallowed.
function swallowClickAfterRelease(pointerId, released) {
  const stop = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  const arm = () => {
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 400);
  };
  if (released) return arm();
  const up = (e) => {
    if (e.pointerId !== pointerId) return;
    forget();
    arm();
  };
  const forget = () => {
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointerdown', forget, true);
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointerdown', forget, true);
  return undefined;
}

function settleTransition(el) {
  const clear = () => {
    el.style.transition = '';
  };
  el.addEventListener('transitionend', clear, { once: true });
  setTimeout(clear, 800);
}
