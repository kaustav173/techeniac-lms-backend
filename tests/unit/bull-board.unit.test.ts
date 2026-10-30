import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Queue } from 'bullmq';
import express from 'express';

import {
  BULL_BOARD_BASE_PATH,
  mountBullBoard,
  registerBullBoardQueue,
} from '../../src/jobs/bull-board';

void describe('Bull Board Adapter Unit Tests', () => {
  void it('exports the expected base path', () => {
    assert.equal(BULL_BOARD_BASE_PATH, '/admin/queues');
  });

  void it('mounts router on express app without throwing', () => {
    const app = express();
    assert.doesNotThrow(() => {
      mountBullBoard(app);
    });
  });

  void it('registers a real BullMQ queue to the board without throwing', async () => {
    const queue = new Queue('test-queue', {
      connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
    });

    try {
      assert.doesNotThrow(() => {
        registerBullBoardQueue(queue);
      });
    } finally {
      await queue.close();
    }
  });
});
