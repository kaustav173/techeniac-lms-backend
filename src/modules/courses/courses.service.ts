import { logAudit } from '../../core/audit';
import type { AuthenticatedUser } from '../../core/auth';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { CourseTopicAction, eventBus } from '../../core/lifecycle';
import { sanitizeHtml } from '../../core/utils/sanitizer';
import { allocationsRepository, CourseAllocationStatus } from '../allocations';
import { AuditType } from '../audit';
import { UserRole } from '../users';
import { coursesRepository } from './courses.repository';
import {
  Assignment,
  AssignmentScope,
  Course,
  type ResourceItem,
  SubmissionMode,
  Subtopic,
  Topic,
} from './entities';
import type { ListCoursesQueryInput } from './schemas/courses.schemas';

// Duration calculation & budget formatting helpers (M6-DUP-1)
function sumMinutes(items?: Array<{ estimatedMinutes?: number | null }>): number {
  return items?.reduce((acc, t) => acc + (t.estimatedMinutes ?? 0), 0) ?? 0;
}

function formatDuration(minutes: number): string {
  const safeMinutes = Math.max(0, minutes);
  return `${Math.floor(safeMinutes / 60)}h ${safeMinutes % 60}m`;
}

function assertWithinBudget(params: {
  parentBudget?: number | null;
  usedMinutes: number;
  requestedMinutes: number;
  itemLabel: string;
  parentLabel: string;
}): void {
  const { parentBudget, usedMinutes, requestedMinutes, itemLabel, parentLabel } = params;
  if (parentBudget !== null && parentBudget !== undefined && parentBudget > 0) {
    const remainingBudget = parentBudget - usedMinutes;
    if (requestedMinutes > remainingBudget) {
      throw new ValidationError(
        `${itemLabel} duration (${formatDuration(requestedMinutes)}) exceeds ${parentLabel} remaining duration budget (${formatDuration(remainingBudget)} remaining out of ${formatDuration(parentBudget)} total).`,
      );
    }
  }
}

function assertFloorBudget(params: {
  parentDuration?: number | null;
  childrenTotalMinutes: number;
  itemLabel: string;
  childLabel: string;
}): void {
  const { parentDuration, childrenTotalMinutes, itemLabel, childLabel } = params;
  if (
    parentDuration !== null &&
    parentDuration !== undefined &&
    parentDuration < childrenTotalMinutes
  ) {
    throw new ValidationError(
      `${itemLabel} duration (${formatDuration(parentDuration)}) cannot be less than the total allocated duration of its ${childLabel} (${formatDuration(childrenTotalMinutes)}).`,
    );
  }
}

export class CoursesService {
  // Permission helper (CRS-18 / Collaborative Course Editing)
  // Defense-in-depth: mirrors the route-level role guard (SUPER_ADMIN or MENTOR);
  // collaborative editing permits any mentor without per-resource creator checks.
  private assertCanEdit(_course: Course, user: AuthenticatedUser): void {
    const userRole = user.role as UserRole;
    if (userRole === UserRole.SUPER_ADMIN || userRole === UserRole.MENTOR) {
      return;
    }
    throw new ForbiddenError('You do not have permission to modify this course');
  }

  // Concurrency helper (FR-6.13, CRS-19)
  private assertNotStale(actualUpdatedAt: Date, expectedUpdatedAt?: string): void {
    if (!expectedUpdatedAt) {
      return;
    }
    const expectedTime = new Date(expectedUpdatedAt).getTime();
    const actualTime = actualUpdatedAt.getTime();
    if (isNaN(expectedTime) || actualTime !== expectedTime) {
      throw new ConflictError(
        'This item was modified concurrently by another user. Please reload the latest changes.',
      );
    }
  }

  // --- Course Service Methods ---
  async createCourse(
    data: {
      title: string;
      description?: string;
      estimatedMinutes?: number;
      isActive?: boolean;
    },
    user: AuthenticatedUser,
  ): Promise<Course> {
    const normalizedTitle = data.title.trim();
    const existing = await coursesRepository.findCourseByTitle(normalizedTitle);
    if (existing) {
      throw new ValidationError(`A course with the title "${normalizedTitle}" already exists`);
    }

    return await coursesRepository.createCourse({
      ...data,
      createdBy: user.id,
      isActive: data.isActive ?? true,
    });
  }

  // Shared library access (PRD Section 9.6, CRS-18):
  // All mentors can view course details and outlines to discover materials and evaluate curricula.
  async getCourseById(
    id: string,
    includeFullOutline = false,
    actor?: AuthenticatedUser,
  ): Promise<Course> {
    const course = await coursesRepository.findCourseById(id, includeFullOutline);
    if (!course) {
      throw new NotFoundError('Course not found');
    }

    const actorRole = actor?.role as UserRole | undefined;
    if (actor && actorRole === UserRole.MENTEE) {
      const allocation = await allocationsRepository.findActiveOrCompletedAllocation(id, actor.id);
      if (!allocation) {
        throw new ForbiddenError('Mentees can only access courses allocated to them');
      }

      if (!course.isActive && allocation.status !== CourseAllocationStatus.COMPLETED) {
        throw new NotFoundError('Course not found');
      }

      // Filter out draft/unpublished topics and subtopics for mentees (F-03)
      if (course.topics) {
        course.topics = course.topics
          .filter((topic) => topic.isActive)
          .map((topic) => {
            if (topic.subtopics) {
              topic.subtopics = topic.subtopics.filter((subtopic) => subtopic.isActive);
            }
            return topic;
          });
      }
    }

    return course;
  }

  async listCourses(options?: Partial<ListCoursesQueryInput>) {
    return await coursesRepository.listCourses(options);
  }

  async updateCourse(
    id: string,
    data: {
      title?: string;
      description?: string | null;
      estimatedMinutes?: number | null;
      isActive?: boolean;
      expectedUpdatedAt?: string;
    },
    user: AuthenticatedUser,
  ): Promise<Course> {
    const course = await this.getCourseById(id, true);
    this.assertCanEdit(course, user);
    this.assertNotStale(course.updatedAt, data.expectedUpdatedAt);

    if (data.title !== undefined) {
      const normalizedTitle = data.title.trim();
      const existing = await coursesRepository.findCourseByTitle(normalizedTitle);
      if (existing && existing.id !== id) {
        throw new ValidationError(`A course with the title "${normalizedTitle}" already exists`);
      }
    }

    if (data.estimatedMinutes !== undefined && data.estimatedMinutes !== null) {
      const topicsSum = sumMinutes(course.topics);
      assertFloorBudget({
        parentDuration: data.estimatedMinutes,
        childrenTotalMinutes: topicsSum,
        itemLabel: 'Course',
        childLabel: 'topics',
      });
    }

    const updatePayload: Partial<Course> = {
      updatedBy: user.id,
    };
    if (data.title !== undefined) updatePayload.title = data.title;
    if (data.description !== undefined) updatePayload.description = data.description;
    if (data.estimatedMinutes !== undefined) updatePayload.estimatedMinutes = data.estimatedMinutes;
    if (data.isActive !== undefined) updatePayload.isActive = data.isActive;

    const updated = await coursesRepository.updateCourse(id, updatePayload, data.expectedUpdatedAt);
    if (!updated) {
      throw new NotFoundError('Course not found');
    }

    await logAudit({
      actorId: user.id,
      type: AuditType.COURSE,
      entity: 'Course',
      entityId: id,
      action: 'LIVE_EDIT',
      oldValue: {
        title: course.title,
        description: course.description,
        estimatedMinutes: course.estimatedMinutes,
        isActive: course.isActive,
      },
      newValue: {
        title: updated.title,
        description: updated.description,
        estimatedMinutes: updated.estimatedMinutes,
        isActive: updated.isActive,
      },
    });

    return updated;
  }

  async toggleCourseStatus(
    id: string,
    isActive: boolean,
    user: AuthenticatedUser,
    expectedUpdatedAt?: string,
  ): Promise<Course> {
    const course = await this.getCourseById(id);
    this.assertCanEdit(course, user);
    this.assertNotStale(course.updatedAt, expectedUpdatedAt);

    const updated = await coursesRepository.updateCourse(
      id,
      {
        isActive,
        updatedBy: user.id,
      },
      expectedUpdatedAt,
    );
    if (!updated) {
      throw new NotFoundError('Course not found');
    }

    await logAudit({
      actorId: user.id,
      type: AuditType.COURSE,
      entity: 'Course',
      entityId: id,
      action: 'COURSE_STATUS_TOGGLED',
      oldValue: { title: course.title, isActive: course.isActive },
      newValue: { title: course.title, isActive },
    });

    return updated;
  }

  async deleteCourse(id: string, user: AuthenticatedUser): Promise<void> {
    const course = await this.getCourseById(id);
    this.assertCanEdit(course, user);

    const impact = await coursesRepository.getCourseImpact(id);
    if (impact.openAllocationsCount > 0) {
      throw new ValidationError(
        'Cannot delete a course with active allocations. Deactivate the course instead.',
      );
    }

    await coursesRepository.softDeleteCourse(id);
  }

  // Shared library access (PRD Section 9.6, CRS-21, FR-6.7, M6-AUTHZ-Q, M6-CLONE-1):
  // Any authenticated mentor can clone any existing course template into an inactive copy owned by themselves.
  // Execution runs inside an all-or-nothing database transaction preventing partial duplicates.
  async cloneCourse(id: string, user: AuthenticatedUser): Promise<Course> {
    await this.getCourseById(id);
    return await coursesRepository.cloneCourse(id, user.id);
  }

  // Shared library access (PRD Section 9.6, M6-AUTHZ-Q):
  // Mentors can view impact statistics (active allocations and mentee counts) across courses.
  async getCourseImpact(id: string) {
    await this.getCourseById(id);
    return await coursesRepository.getCourseImpact(id);
  }

  // --- Topic Service Methods ---
  async createTopic(
    courseId: string,
    data: {
      title: string;
      description?: string;
      resources?: ResourceItem[];
      displayOrder?: number;
      estimatedMinutes?: number;
      isActive?: boolean;
    },
    user: AuthenticatedUser,
  ): Promise<Topic> {
    const course = await this.getCourseById(courseId, true);
    this.assertCanEdit(course, user);

    const normalizedTitle = data.title.trim().toLowerCase();
    const duplicateTopic = course.topics?.find(
      (t) => t.title.trim().toLowerCase() === normalizedTitle,
    );
    if (duplicateTopic) {
      throw new ValidationError(
        `A topic with the title "${data.title.trim()}" already exists in this course`,
      );
    }

    for (const t of course.topics ?? []) {
      const duplicateSubtopic = t.subtopics?.find(
        (s) => s.title.trim().toLowerCase() === normalizedTitle,
      );
      if (duplicateSubtopic) {
        throw new ValidationError(
          `A topic cannot share the same title "${data.title.trim()}" with an existing subtopic in this course`,
        );
      }
    }

    if (data.estimatedMinutes !== undefined && data.estimatedMinutes !== null) {
      const otherTopicsSum = sumMinutes(course.topics);
      assertWithinBudget({
        parentBudget: course.estimatedMinutes,
        usedMinutes: otherTopicsSum,
        requestedMinutes: data.estimatedMinutes,
        itemLabel: 'Topic',
        parentLabel: "the course's",
      });
    }

    const topic = await coursesRepository.createTopic({
      courseId,
      title: data.title,
      description: data.description,
      resources: data.resources,
      displayOrder: data.displayOrder,
      isActive: data.isActive ?? true,
      estimatedMinutes: data.estimatedMinutes,
      createdBy: user.id,
    });

    // Emit FR-6.15 lifecycle event
    eventBus.emitEvent('course.topicsChanged', {
      courseId,
      topicId: topic.id,
      action: CourseTopicAction.ADDED,
    });

    return topic;
  }

  async updateTopic(
    id: string,
    data: {
      title?: string;
      description?: string | null;
      resources?: ResourceItem[] | null;
      displayOrder?: number;
      estimatedMinutes?: number | null;
      isActive?: boolean;
      expectedUpdatedAt?: string;
    },
    user: AuthenticatedUser,
  ): Promise<Topic> {
    const topic = await coursesRepository.findTopicById(id);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId, true);
    this.assertCanEdit(course, user);
    this.assertNotStale(topic.updatedAt, data.expectedUpdatedAt);

    if (data.estimatedMinutes !== undefined && data.estimatedMinutes !== null) {
      // 1. Check parent course budget ceiling (if course has estimatedMinutes)
      const otherTopicsSum = sumMinutes(course.topics?.filter((t) => t.id !== id));
      assertWithinBudget({
        parentBudget: course.estimatedMinutes,
        usedMinutes: otherTopicsSum,
        requestedMinutes: data.estimatedMinutes,
        itemLabel: 'Topic',
        parentLabel: "the course's",
      });

      // 2. Check subtopics floor
      const subtopicsSum = sumMinutes(topic.subtopics);
      assertFloorBudget({
        parentDuration: data.estimatedMinutes,
        childrenTotalMinutes: subtopicsSum,
        itemLabel: 'Topic',
        childLabel: 'subtopics',
      });
    }

    if (data.title !== undefined) {
      const normalizedTitle = data.title.trim().toLowerCase();
      const duplicateTopic = course.topics?.find(
        (t) => t.id !== id && t.title.trim().toLowerCase() === normalizedTitle,
      );
      if (duplicateTopic) {
        throw new ValidationError(
          `A topic with the title "${data.title.trim()}" already exists in this course`,
        );
      }

      for (const t of course.topics ?? []) {
        const duplicateSubtopic = t.subtopics?.find(
          (s) => s.title.trim().toLowerCase() === normalizedTitle,
        );
        if (duplicateSubtopic) {
          throw new ValidationError(
            `A topic cannot share the same title "${data.title.trim()}" with an existing subtopic in this course`,
          );
        }
      }
    }

    const updatePayload: Partial<Topic> = { updatedBy: user.id };
    if (data.title !== undefined) updatePayload.title = data.title;
    if (data.description !== undefined) updatePayload.description = data.description;
    if (data.resources !== undefined) updatePayload.resources = data.resources;
    if (data.displayOrder !== undefined) updatePayload.displayOrder = data.displayOrder;
    if (data.estimatedMinutes !== undefined) updatePayload.estimatedMinutes = data.estimatedMinutes;
    if (data.isActive !== undefined) updatePayload.isActive = data.isActive;

    const updated = await coursesRepository.updateTopic(id, updatePayload, data.expectedUpdatedAt);
    if (!updated) {
      throw new NotFoundError('Topic not found');
    }
    return updated;
  }

  async toggleTopicStatus(
    id: string,
    isActive: boolean,
    user: AuthenticatedUser,
    expectedUpdatedAt?: string,
  ): Promise<Topic> {
    const topic = await coursesRepository.findTopicById(id);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId);
    this.assertCanEdit(course, user);
    this.assertNotStale(topic.updatedAt, expectedUpdatedAt);

    const updated = await coursesRepository.updateTopic(
      id,
      {
        isActive,
        updatedBy: user.id,
      },
      expectedUpdatedAt,
    );

    // Emit FR-6.15 lifecycle event
    eventBus.emitEvent('course.topicsChanged', {
      courseId: topic.courseId,
      topicId: topic.id,
      action: isActive ? CourseTopicAction.REACTIVATED : CourseTopicAction.DEACTIVATED,
    });

    if (!updated) {
      throw new NotFoundError('Topic not found');
    }
    return updated;
  }

  async deleteTopic(id: string, user: AuthenticatedUser): Promise<void> {
    const topic = await coursesRepository.findTopicById(id);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId);
    this.assertCanEdit(course, user);

    await coursesRepository.deleteTopic(id);

    // Emit FR-6.15 lifecycle event
    eventBus.emitEvent('course.topicsChanged', {
      courseId: topic.courseId,
      topicId: id,
      action: CourseTopicAction.DELETED,
    });
  }

  async reorderTopics(
    courseId: string,
    items: { id: string; displayOrder: number }[],
    user: AuthenticatedUser,
  ): Promise<void> {
    const course = await this.getCourseById(courseId, true);
    this.assertCanEdit(course, user);

    const existingTopicIds = new Set(course.topics?.map((t) => t.id) ?? []);
    for (const item of items) {
      if (!existingTopicIds.has(item.id)) {
        throw new ValidationError(`Topic ${item.id} does not belong to this course`);
      }
    }

    await coursesRepository.reorderTopics(courseId, items);
  }

  // --- Subtopic Service Methods ---
  async createSubtopic(
    topicId: string,
    data: {
      title: string;
      content?: string;
      resources?: ResourceItem[];
      displayOrder?: number;
      estimatedMinutes?: number;
      isActive?: boolean;
    },
    user: AuthenticatedUser,
  ): Promise<Subtopic> {
    const topic = await coursesRepository.findTopicById(topicId);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId, true);
    this.assertCanEdit(course, user);

    const normalizedTitle = data.title.trim().toLowerCase();
    const duplicateSibling = topic.subtopics?.find(
      (s) => s.title.trim().toLowerCase() === normalizedTitle,
    );
    if (duplicateSibling) {
      throw new ValidationError(
        `A subtopic with the title "${data.title.trim()}" already exists in this topic`,
      );
    }

    const duplicateTopic = course.topics?.find(
      (t) => t.title.trim().toLowerCase() === normalizedTitle,
    );
    if (duplicateTopic) {
      throw new ValidationError(
        `A subtopic cannot share the same title "${data.title.trim()}" with a topic in this course`,
      );
    }

    if (data.estimatedMinutes !== undefined && data.estimatedMinutes !== null) {
      const otherSubtopicsSum = sumMinutes(topic.subtopics);
      assertWithinBudget({
        parentBudget: topic.estimatedMinutes,
        usedMinutes: otherSubtopicsSum,
        requestedMinutes: data.estimatedMinutes,
        itemLabel: 'Subtopic',
        parentLabel: `topic "${topic.title}"`,
      });
    }

    // Sanitize rich-text content (CRS-23)
    const sanitizedContent = data.content ? sanitizeHtml(data.content) : null;

    return await coursesRepository.createSubtopic({
      topicId,
      title: data.title,
      content: sanitizedContent,
      resources: data.resources ?? null,
      displayOrder: data.displayOrder,
      isActive: data.isActive ?? true,
      estimatedMinutes: data.estimatedMinutes,
      createdBy: user.id,
    });
  }

  async updateSubtopic(
    id: string,
    data: {
      title?: string;
      content?: string | null;
      resources?: ResourceItem[] | null;
      displayOrder?: number;
      estimatedMinutes?: number | null;
      isActive?: boolean;
      expectedUpdatedAt?: string;
    },
    user: AuthenticatedUser,
  ): Promise<Subtopic> {
    const subtopic = await coursesRepository.findSubtopicById(id);
    if (!subtopic) {
      throw new NotFoundError('Subtopic not found');
    }
    const topic = await coursesRepository.findTopicById(subtopic.topicId);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId, true);
    this.assertCanEdit(course, user);
    this.assertNotStale(subtopic.updatedAt, data.expectedUpdatedAt);

    if (data.title !== undefined) {
      const normalizedTitle = data.title.trim().toLowerCase();
      const duplicateSibling = topic.subtopics?.find(
        (s) => s.id !== id && s.title.trim().toLowerCase() === normalizedTitle,
      );
      if (duplicateSibling) {
        throw new ValidationError(
          `A subtopic with the title "${data.title.trim()}" already exists in this topic`,
        );
      }

      const duplicateTopic = course.topics?.find(
        (t) => t.title.trim().toLowerCase() === normalizedTitle,
      );
      if (duplicateTopic) {
        throw new ValidationError(
          `A subtopic cannot share the same title "${data.title.trim()}" with a topic in this course`,
        );
      }
    }

    if (data.estimatedMinutes !== undefined && data.estimatedMinutes !== null) {
      const otherSubtopicsSum = sumMinutes(topic.subtopics?.filter((s) => s.id !== id));
      assertWithinBudget({
        parentBudget: topic.estimatedMinutes,
        usedMinutes: otherSubtopicsSum,
        requestedMinutes: data.estimatedMinutes,
        itemLabel: 'Subtopic',
        parentLabel: `topic "${topic.title}"`,
      });
    }

    const updatePayload: Partial<Subtopic> = { updatedBy: user.id };
    if (data.title !== undefined) updatePayload.title = data.title;
    if (data.content !== undefined) {
      updatePayload.content = data.content ? sanitizeHtml(data.content) : null;
    }
    if (data.resources !== undefined) updatePayload.resources = data.resources;
    if (data.displayOrder !== undefined) updatePayload.displayOrder = data.displayOrder;
    if (data.estimatedMinutes !== undefined) updatePayload.estimatedMinutes = data.estimatedMinutes;
    if (data.isActive !== undefined) updatePayload.isActive = data.isActive;

    const updated = await coursesRepository.updateSubtopic(
      id,
      updatePayload,
      data.expectedUpdatedAt,
    );
    if (!updated) {
      throw new NotFoundError('Subtopic not found');
    }
    return updated;
  }

  async toggleSubtopicStatus(
    id: string,
    isActive: boolean,
    user: AuthenticatedUser,
    expectedUpdatedAt?: string,
  ): Promise<Subtopic> {
    const subtopic = await coursesRepository.findSubtopicById(id);
    if (!subtopic) {
      throw new NotFoundError('Subtopic not found');
    }
    const topic = await coursesRepository.findTopicById(subtopic.topicId);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId);
    this.assertCanEdit(course, user);
    this.assertNotStale(subtopic.updatedAt, expectedUpdatedAt);

    const updated = await coursesRepository.updateSubtopic(
      id,
      {
        isActive,
        updatedBy: user.id,
      },
      expectedUpdatedAt,
    );
    if (!updated) {
      throw new NotFoundError('Subtopic not found');
    }
    return updated;
  }

  async deleteSubtopic(id: string, user: AuthenticatedUser): Promise<void> {
    const subtopic = await coursesRepository.findSubtopicById(id);
    if (!subtopic) {
      throw new NotFoundError('Subtopic not found');
    }
    const topic = await coursesRepository.findTopicById(subtopic.topicId);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId);
    this.assertCanEdit(course, user);

    await coursesRepository.deleteSubtopic(id);
  }

  async reorderSubtopics(
    topicId: string,
    items: { id: string; displayOrder: number }[],
    user: AuthenticatedUser,
  ): Promise<void> {
    const topic = await coursesRepository.findTopicById(topicId);
    if (!topic) {
      throw new NotFoundError('Topic not found');
    }
    const course = await this.getCourseById(topic.courseId);
    this.assertCanEdit(course, user);

    const existingSubtopicIds = new Set(topic.subtopics?.map((s) => s.id) ?? []);
    for (const item of items) {
      if (!existingSubtopicIds.has(item.id)) {
        throw new ValidationError(`Subtopic ${item.id} does not belong to this topic`);
      }
    }

    await coursesRepository.reorderSubtopics(topicId, items);
  }

  // --- Assignment Service Methods ---
  async createAssignment(
    courseId: string,
    data: {
      scope: AssignmentScope;
      topicId?: string | null;
      title: string;
      instructions?: string;
      estimatedMinutes: number;
      maxMarks: number;
      passMarks: number;
      allowLate?: boolean;
      pdfMode: SubmissionMode;
      zipMode: SubmissionMode;
      urlMode: SubmissionMode;
      resources?: ResourceItem[];
      displayOrder?: number;
    },
    user: AuthenticatedUser,
  ): Promise<Assignment> {
    const course = await this.getCourseById(courseId, true);
    this.assertCanEdit(course, user);

    const normalizedTitle = data.title.trim().toLowerCase();
    if (data.scope === AssignmentScope.COURSE) {
      const duplicateCourseAssign = (course.courseAssignments || course.assignments)?.find(
        (a) => a.title.trim().toLowerCase() === normalizedTitle,
      );
      if (duplicateCourseAssign) {
        throw new ValidationError(
          `A course assignment with the title "${data.title.trim()}" already exists in this course`,
        );
      }
    } else if (data.scope === AssignmentScope.TOPIC && data.topicId) {
      const topic = await coursesRepository.findTopicById(data.topicId);
      if (!topic || topic.courseId !== courseId) {
        throw new ValidationError('Specified topic does not belong to this course');
      }

      const duplicateTopicAssign = topic.assignments?.find(
        (a) => a.title.trim().toLowerCase() === normalizedTitle,
      );
      if (duplicateTopicAssign) {
        throw new ValidationError(
          `A task with the title "${data.title.trim()}" already exists in this topic`,
        );
      }
    }

    if (data.scope === AssignmentScope.TOPIC && data.topicId) {
      const topic = await coursesRepository.findTopicById(data.topicId);
      if (!topic || topic.courseId !== courseId) {
        throw new ValidationError('Specified topic does not belong to this course');
      }
    }

    // Sanitize instructions
    const sanitizedInstructions = data.instructions ? sanitizeHtml(data.instructions) : null;

    return await coursesRepository.createAssignment({
      courseId,
      topicId: data.scope === AssignmentScope.TOPIC ? data.topicId : null,
      scope: data.scope,
      displayOrder: data.displayOrder,
      title: data.title,
      instructions: sanitizedInstructions,
      estimatedMinutes: data.estimatedMinutes,
      maxMarks: data.maxMarks,
      passMarks: data.passMarks,
      allowLate: data.allowLate ?? false,
      pdfMode: data.pdfMode,
      zipMode: data.zipMode,
      urlMode: data.urlMode,
      resources: data.resources ?? null,
      createdBy: user.id,
    });
  }

  async updateAssignment(
    id: string,
    data: {
      title?: string;
      instructions?: string | null;
      estimatedMinutes?: number;
      maxMarks?: number;
      passMarks?: number;
      allowLate?: boolean;
      pdfMode?: SubmissionMode;
      zipMode?: SubmissionMode;
      urlMode?: SubmissionMode;
      resources?: ResourceItem[] | null;
      displayOrder?: number;
      expectedUpdatedAt?: string;
    },
    user: AuthenticatedUser,
  ): Promise<Assignment> {
    const assignment = await coursesRepository.findAssignmentById(id);
    if (!assignment) {
      throw new NotFoundError('Assignment not found');
    }
    const course = await this.getCourseById(assignment.courseId, true);
    this.assertCanEdit(course, user);
    this.assertNotStale(assignment.updatedAt, data.expectedUpdatedAt);

    if (data.title !== undefined) {
      const normalizedTitle = data.title.trim().toLowerCase();
      if (assignment.scope === AssignmentScope.COURSE) {
        const duplicateCourseAssign = (course.courseAssignments || course.assignments)?.find(
          (a) => a.id !== id && a.title.trim().toLowerCase() === normalizedTitle,
        );
        if (duplicateCourseAssign) {
          throw new ValidationError(
            `A course assignment with the title "${data.title.trim()}" already exists in this course`,
          );
        }
      } else if (assignment.scope === AssignmentScope.TOPIC && assignment.topicId) {
        const topic = await coursesRepository.findTopicById(assignment.topicId);
        const duplicateTopicAssign = topic?.assignments?.find(
          (a) => a.id !== id && a.title.trim().toLowerCase() === normalizedTitle,
        );
        if (duplicateTopicAssign) {
          throw new ValidationError(
            `A task with the title "${data.title.trim()}" already exists in this topic`,
          );
        }
      }
    }

    const nextMaxMarks = Number(data.maxMarks !== undefined ? data.maxMarks : assignment.maxMarks);
    const nextPassMarks = Number(
      data.passMarks !== undefined ? data.passMarks : assignment.passMarks,
    );
    if (nextPassMarks > nextMaxMarks) {
      throw new ValidationError('Pass marks cannot exceed max marks');
    }

    const nextPdfMode = data.pdfMode !== undefined ? data.pdfMode : assignment.pdfMode;
    const nextZipMode = data.zipMode !== undefined ? data.zipMode : assignment.zipMode;
    const nextUrlMode = data.urlMode !== undefined ? data.urlMode : assignment.urlMode;
    if (
      nextPdfMode === SubmissionMode.OFF &&
      nextZipMode === SubmissionMode.OFF &&
      nextUrlMode === SubmissionMode.OFF
    ) {
      throw new ValidationError('At least one submission mode (PDF, ZIP, or URL) must be enabled');
    }

    const updatePayload: Partial<Assignment> = { updatedBy: user.id };
    if (data.title !== undefined) updatePayload.title = data.title;
    if (data.instructions !== undefined) {
      updatePayload.instructions = data.instructions ? sanitizeHtml(data.instructions) : null;
    }
    if (data.estimatedMinutes !== undefined) updatePayload.estimatedMinutes = data.estimatedMinutes;
    if (data.maxMarks !== undefined) updatePayload.maxMarks = data.maxMarks;
    if (data.passMarks !== undefined) updatePayload.passMarks = data.passMarks;
    if (data.allowLate !== undefined) updatePayload.allowLate = data.allowLate;
    if (data.pdfMode !== undefined) updatePayload.pdfMode = data.pdfMode;
    if (data.zipMode !== undefined) updatePayload.zipMode = data.zipMode;
    if (data.urlMode !== undefined) updatePayload.urlMode = data.urlMode;
    if (data.resources !== undefined) updatePayload.resources = data.resources;
    if (data.displayOrder !== undefined) updatePayload.displayOrder = data.displayOrder;

    const updated = await coursesRepository.updateAssignment(
      id,
      updatePayload,
      data.expectedUpdatedAt,
    );
    if (!updated) {
      throw new NotFoundError('Assignment not found');
    }
    return updated;
  }

  async deleteAssignment(id: string, user: AuthenticatedUser): Promise<void> {
    const assignment = await coursesRepository.findAssignmentById(id);
    if (!assignment) {
      throw new NotFoundError('Assignment not found');
    }
    const course = await this.getCourseById(assignment.courseId);
    this.assertCanEdit(course, user);

    await coursesRepository.deleteAssignment(id);
  }

  async reorderAssignments(
    courseId: string,
    items: { id: string; displayOrder: number }[],
    user: AuthenticatedUser,
  ): Promise<void> {
    const course = await this.getCourseById(courseId, true);
    this.assertCanEdit(course, user);

    const courseLevelIds = course.assignments?.map((a) => a.id) ?? [];
    const topicLevelIds =
      course.topics?.flatMap((t) => t.assignments?.map((a) => a.id) ?? []) ?? [];
    const existingAssignmentIds = new Set([...courseLevelIds, ...topicLevelIds]);
    for (const item of items) {
      if (!existingAssignmentIds.has(item.id)) {
        throw new ValidationError(`Assignment ${item.id} does not belong to this course`);
      }
    }

    await coursesRepository.reorderAssignments(courseId, items);
  }
}

export const coursesService = new CoursesService();
