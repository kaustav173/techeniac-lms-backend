import { EventEmitter } from 'node:events';

import { logger } from '../logging';

export enum CourseTopicAction {
  ADDED = 'ADDED',
  DEACTIVATED = 'DEACTIVATED',
  REACTIVATED = 'REACTIVATED',
  DELETED = 'DELETED',
}

export interface CourseTopicsChangedEvent {
  courseId: string;
  topicId: string;
  action: CourseTopicAction;
}

export interface AllocationCreatedEvent {
  allocationIds: string[];
  courseId: string;
}

export interface AllocationDeadlineChangedEvent {
  allocationId: string;
  dueDate: string;
}

export interface UserRoleChangedEvent {
  userId: string;
  oldRole: string;
  newRole: string;
  actorId?: string;
}

export interface BatchMemberJoinedEvent {
  batchId: string;
  userId: string;
  role: string;
  actorId?: string;
}

export interface BatchMemberTransferredEvent {
  sourceBatchId: string;
  targetBatchId: string;
  menteeId: string;
  actorId?: string;
}

export interface AllocationOverdueDetectedEvent {
  allocationId: string;
  userId: string;
  courseId: string;
  dueDate: Date;
}

export interface TopicOverdueDetectedEvent {
  topicProgressId: string;
  courseAllocationId: string;
  topicId: string;
  deadline: Date;
}

export interface AllocationReminderDueEvent {
  allocationId: string;
  userId: string;
  courseId: string;
  dueDate: Date;
  hoursRemaining: number;
}

export type LifecycleEvents = {
  'course.topicsChanged': CourseTopicsChangedEvent;
  'allocation.created': AllocationCreatedEvent;
  'allocation.deadlineChanged': AllocationDeadlineChangedEvent;
  'user.roleChanged': UserRoleChangedEvent;
  'batch.memberJoined': BatchMemberJoinedEvent;
  'batch.memberTransferred': BatchMemberTransferredEvent;
  'allocation.overdueDetected': AllocationOverdueDetectedEvent;
  'topic.overdueDetected': TopicOverdueDetectedEvent;
  'allocation.reminderDue': AllocationReminderDueEvent;
};

class LifecycleEventBus extends EventEmitter {
  public emitEvent<K extends keyof LifecycleEvents>(
    event: K,
    payload: LifecycleEvents[K],
  ): boolean {
    logger.info({ event, payload }, `[LifecycleEventBus] Emitting event: ${String(event)}`);
    return this.emit(String(event), payload);
  }

  public onEvent<K extends keyof LifecycleEvents>(
    event: K,
    listener: (payload: LifecycleEvents[K]) => void | Promise<void>,
  ): this {
    return this.on(String(event), (payload: LifecycleEvents[K]) => {
      void Promise.resolve(listener(payload)).catch((err: unknown) => {
        logger.error({ err, event: String(event) }, '[LifecycleEventBus] Error in event listener');
      });
    });
  }
}

export const eventBus = new LifecycleEventBus();
