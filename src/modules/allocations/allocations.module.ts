import { eventBus } from '../../core/lifecycle';
import { logger } from '../../core/logging';
import { allocationsService } from './allocations.service';

let listenersRegistered = false;

export function registerAllocationLifecycleListeners(): void {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  eventBus.onEvent('user.roleChanged', async (payload) => {
    await allocationsService.handleUserRoleChanged(payload);
  });

  eventBus.onEvent('batch.memberJoined', async (payload) => {
    await allocationsService.handleBatchMemberJoined(payload);
  });

  eventBus.onEvent('batch.memberTransferred', async (payload) => {
    try {
      await allocationsService.handleBatchMemberTransferred({
        batchId: payload.sourceBatchId,
        newBatchId: payload.targetBatchId,
        menteeId: payload.menteeId,
        actorId: payload.actorId,
      });
    } catch (err) {
      logger.error({ err }, 'Error in batch.memberTransferred allocation handler');
    }
  });
}
