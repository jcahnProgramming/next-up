import { z } from 'zod';
import { declareEventType } from '../core/events.js';

// Board-level changes. Never the password or its hash: only whether there is one. Never restorable.
export const BOARD_CREATED = declareEventType({
  type: 'board.created',
  restorable: false,
  payload: z.object({ hasPassword: z.boolean() }),
  line: (p) => ({ verb: 'created the board', subject: '', detail: p.hasPassword ? ' with a password' : '' }),
});
