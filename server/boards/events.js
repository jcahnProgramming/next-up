import { z } from 'zod';
import { declareEventType } from '../core/events.js';

// Board-level changes. Never the password or its hash: only whether there is one.
export const BOARD_CREATED = declareEventType({
  type: 'board.created',
  restorable: false,
  payload: z.object({ hasPassword: z.boolean() }),
});
