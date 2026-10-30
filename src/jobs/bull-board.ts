import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Queue } from 'bullmq';
import type { Express, RequestHandler } from 'express';

export const BULL_BOARD_BASE_PATH = '/admin/queues';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);

const board = createBullBoard({
  queues: [],
  serverAdapter,
});

export function registerBullBoardQueue(queue: Queue): void {
  board.addQueue(new BullMQAdapter(queue));
}

export function mountBullBoard(app: Express): void {
  app.use(BULL_BOARD_BASE_PATH, serverAdapter.getRouter() as RequestHandler);
}
