import { z } from 'zod';
import { declareEventType } from '../core/events.js';

// Board-level changes. Never the password or its hash: only whether there is one, and that it changed. None is
// restorable through History: a password change can't be undone, and a deletion has its own Restore (the banner and
// Settings), which writes board.deletion_cancelled.
export const BOARD_CREATED = declareEventType({
  type: 'board.created',
  restorable: false,
  payload: z.object({ hasPassword: z.boolean() }),
  line: (p) => ({ verb: 'created the board', subject: '', detail: p.hasPassword ? ' with a password' : '' }),
});

export const BOARD_PASSWORD_CHANGED = declareEventType({
  type: 'board.password_changed',
  restorable: false,
  payload: z.object({}),
  line: () => ({ verb: 'changed the board password', subject: '', detail: '' }),
});

// purgeAt: when the board will be erased unless someone restores it first (boards/retire.js).
export const BOARD_DELETION_SCHEDULED = declareEventType({
  type: 'board.deletion_scheduled',
  restorable: false,
  payload: z.object({ purgeAt: z.string() }),
  line: () => ({ verb: 'deleted the board', subject: '', detail: ' · erased in 24 hours unless restored', tone: 'del' }),
});

export const BOARD_DELETION_CANCELLED = declareEventType({
  type: 'board.deletion_cancelled',
  restorable: false,
  payload: z.object({}),
  line: () => ({ verb: 'restored the board', subject: '', detail: ' · it won’t be deleted' }),
});
