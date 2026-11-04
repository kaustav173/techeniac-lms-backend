import { In, IsNull } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors';
import { Assignment, AssignmentScope, Course, Subtopic, Topic } from './entities';

export interface CourseImpactInfo {
  courseId: string;
  openAllocationsCount: number;
  affectedMenteesCount: number;
}

export class CoursesRepository {
  private get courseRepo() {
    return AppDataSource.getRepository(Course);
  }

  private get topicRepo() {
    return AppDataSource.getRepository(Topic);
  }

  private get subtopicRepo() {
    return AppDataSource.getRepository(Subtopic);
  }

  private get assignmentRepo() {
    return AppDataSource.getRepository(Assignment);
  }

  // --- Course Operations ---
  async createCourse(data: Partial<Course>): Promise<Course> {
    const course = this.courseRepo.create(data);
    return await this.courseRepo.save(course);
  }

  async findCourseById(id: string, includeFullOutline = false): Promise<Course | null> {
    const course = await this.courseRepo
      .createQueryBuilder('course')
      .leftJoin('course.creator', 'creator')
      .addSelect(['creator.id', 'creator.name'])
      .where('course.id = :id', { id })
      .getOne();

    if (!course || !includeFullOutline) {
      return course;
    }

    const [topics, assignments] = await Promise.all([
      this.topicRepo.find({
        where: { courseId: id },
        order: { displayOrder: 'ASC' },
      }),
      this.assignmentRepo.find({
        where: { courseId: id },
        order: { displayOrder: 'ASC' },
      }),
    ]);

    const topicIds = topics.map((t) => t.id);
    const subtopics =
      topicIds.length > 0
        ? await this.subtopicRepo.find({
            where: { topicId: In(topicIds) },
            order: { displayOrder: 'ASC' },
          })
        : [];

    for (const topic of topics) {
      topic.subtopics = subtopics.filter((s) => s.topicId === topic.id);
      topic.assignments = assignments.filter(
        (a) => a.scope === AssignmentScope.TOPIC && a.topicId === topic.id,
      );
    }

    course.topics = topics;
    course.assignments = assignments.filter((a) => a.scope === AssignmentScope.COURSE);
    course.courseAssignments = course.assignments;

    return course;
  }

  async listCourses(options?: {
    page?: number;
    limit?: number;
    search?: string;
    isActive?: boolean;
    sortBy?: 'createdAt' | 'title' | 'updatedAt' | 'topics' | 'tasks';
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ items: Course[]; total: number }> {
    const page = options?.page && options.page > 0 ? options.page : 1;
    const limit = options?.limit && options.limit > 0 ? options.limit : 10;
    const sortBy = options?.sortBy ?? 'createdAt';
    const sortOrder = options?.sortOrder ?? 'desc';

    const qb = this.courseRepo
      .createQueryBuilder('course')
      .leftJoin('course.creator', 'creator')
      .addSelect(['creator.id', 'creator.name'])
      .where('course.deletedAt IS NULL');

    if (options?.isActive !== undefined) {
      qb.andWhere('course.isActive = :isActive', { isActive: options.isActive });
    }

    if (options?.search) {
      const escaped = options.search.replace(/[%_\\]/g, '\\$&');
      qb.andWhere(
        `(course.title ILIKE :search ESCAPE '\\' OR course.description ILIKE :search ESCAPE '\\')`,
        {
          search: `%${escaped}%`,
        },
      );
    }

    const safeSortOrder = (sortOrder || 'desc').toUpperCase() as 'ASC' | 'DESC';

    if (sortBy === 'topics') {
      qb.addSelect(
        (subQuery) =>
          subQuery
            .select('COUNT(t.id)', 'topic_count')
            .from('topics', 't')
            .where('t.course_id = course.id')
            .andWhere('t.deleted_at IS NULL'),
        'topic_count',
      );
      qb.orderBy('topic_count', safeSortOrder, 'NULLS LAST');
    } else if (sortBy === 'tasks') {
      qb.addSelect(
        (subQuery) =>
          subQuery
            .select('COUNT(a.id)', 'assignment_count')
            .from('assignments', 'a')
            .where('a.course_id = course.id')
            .andWhere('a.deleted_at IS NULL'),
        'assignment_count',
      );
      qb.orderBy('assignment_count', safeSortOrder, 'NULLS LAST');
    } else if (sortBy === 'title') {
      qb.orderBy('LOWER(course.title)', safeSortOrder);
    } else if (sortBy === 'updatedAt') {
      qb.orderBy('course.updatedAt', safeSortOrder);
    } else {
      qb.orderBy('course.createdAt', safeSortOrder);
    }

    qb.skip((page - 1) * limit).take(limit);

    const [items, total] = await qb.getManyAndCount();

    const courseIds = items.map((c) => c.id);
    if (courseIds.length > 0) {
      const topicCounts = await this.topicRepo
        .createQueryBuilder('topic')
        .select('topic.courseId', 'courseId')
        .addSelect('COUNT(*)', 'count')
        .where('topic.courseId IN (:...courseIds)', { courseIds })
        .andWhere('topic.deletedAt IS NULL')
        .groupBy('topic.courseId')
        .getRawMany<{ courseId: string; count: string }>();

      const assignmentCounts = await this.assignmentRepo
        .createQueryBuilder('assignment')
        .select('assignment.courseId', 'courseId')
        .addSelect('COUNT(*)', 'count')
        .where('assignment.courseId IN (:...courseIds)', { courseIds })
        .andWhere('assignment.deletedAt IS NULL')
        .groupBy('assignment.courseId')
        .getRawMany<{ courseId: string; count: string }>();

      const topicCountMap = new Map(topicCounts.map((t) => [t.courseId, parseInt(t.count, 10)]));
      const assignmentCountMap = new Map(
        assignmentCounts.map((a) => [a.courseId, parseInt(a.count, 10)]),
      );

      for (const item of items) {
        item.topicCount = topicCountMap.get(item.id) ?? 0;
        item.assignmentCount = assignmentCountMap.get(item.id) ?? 0;
      }
    }

    return { items, total };
  }

  async updateCourse(
    id: string,
    data: Partial<Course>,
    expectedUpdatedAt?: string,
  ): Promise<Course | null> {
    const qb = this.courseRepo
      .createQueryBuilder()
      .update(Course)
      .set({ ...data, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('deletedAt IS NULL');

    if (expectedUpdatedAt) {
      qb.andWhere(
        "date_trunc('milliseconds', updatedAt) = date_trunc('milliseconds', :expectedUpdatedAt::timestamptz)",
        { expectedUpdatedAt },
      );
    }

    const res = await qb.execute();
    if (res.affected === 0) {
      const exists = await this.courseRepo.findOne({ where: { id } });
      if (!exists) {
        return null;
      }
      throw new ConflictError(
        'This item was modified concurrently by another user. Please reload the latest changes.',
      );
    }
    return await this.courseRepo.findOne({ where: { id } });
  }

  async cloneCourse(sourceCourseId: string, newCreatorId: string): Promise<Course> {
    return await AppDataSource.transaction(async (manager) => {
      const source = await this.findCourseById(sourceCourseId, true);
      if (!source) {
        throw new NotFoundError('Source course not found');
      }

      // 1. Create inactive course copy (FR-6.7, CRS-21)
      const courseRepo = manager.getRepository(Course);
      const clonedCourse = courseRepo.create({
        title: `${source.title} (Copy)`.slice(0, 150),
        description: source.description,
        estimatedMinutes: source.estimatedMinutes,
        isActive: false,
        createdBy: newCreatorId,
      });
      const savedCourse = await courseRepo.save(clonedCourse);

      // 2. Clone topics and build oldId -> newId map
      const topicRepo = manager.getRepository(Topic);
      const subtopicRepo = manager.getRepository(Subtopic);
      const assignmentRepo = manager.getRepository(Assignment);

      if (source.topics && source.topics.length > 0) {
        for (const t of source.topics) {
          const clonedTopic = topicRepo.create({
            courseId: savedCourse.id,
            title: t.title,
            description: t.description,
            resources: t.resources,
            displayOrder: t.displayOrder,
            isActive: t.isActive,
            estimatedMinutes: t.estimatedMinutes,
            createdBy: newCreatorId,
          });
          const savedTopic = await topicRepo.save(clonedTopic);

          // Batch clone subtopics for this topic
          if (t.subtopics && t.subtopics.length > 0) {
            const subtopicsToInsert = t.subtopics.map((st) =>
              subtopicRepo.create({
                topicId: savedTopic.id,
                title: st.title,
                content: st.content,
                resources: st.resources,
                displayOrder: st.displayOrder,
                isActive: st.isActive,
                estimatedMinutes: st.estimatedMinutes,
                createdBy: newCreatorId,
              }),
            );
            await subtopicRepo.save(subtopicsToInsert);
          }

          // Batch clone topic-level assignments for this topic
          if (t.assignments && t.assignments.length > 0) {
            const assignmentsToInsert = t.assignments.map((a) =>
              assignmentRepo.create({
                courseId: savedCourse.id,
                topicId: savedTopic.id,
                scope: a.scope,
                displayOrder: a.displayOrder,
                title: a.title,
                instructions: a.instructions,
                estimatedMinutes: a.estimatedMinutes,
                maxMarks: a.maxMarks,
                passMarks: a.passMarks,
                allowLate: a.allowLate,
                pdfMode: a.pdfMode,
                zipMode: a.zipMode,
                urlMode: a.urlMode,
                resources: a.resources,
                createdBy: newCreatorId,
              }),
            );
            await assignmentRepo.save(assignmentsToInsert);
          }
        }
      }

      // 3. Batch clone course-level assignments
      if (source.assignments && source.assignments.length > 0) {
        const courseLevelAssignments = source.assignments.filter(
          (a) => a.scope === AssignmentScope.COURSE,
        );
        if (courseLevelAssignments.length > 0) {
          const courseAssignmentsToInsert = courseLevelAssignments.map((a) =>
            assignmentRepo.create({
              courseId: savedCourse.id,
              topicId: null,
              scope: AssignmentScope.COURSE,
              displayOrder: a.displayOrder,
              title: a.title,
              instructions: a.instructions,
              estimatedMinutes: a.estimatedMinutes,
              maxMarks: a.maxMarks,
              passMarks: a.passMarks,
              allowLate: a.allowLate,
              pdfMode: a.pdfMode,
              zipMode: a.zipMode,
              urlMode: a.urlMode,
              resources: a.resources,
              createdBy: newCreatorId,
            }),
          );
          await assignmentRepo.save(courseAssignmentsToInsert);
        }
      }

      return savedCourse;
    });
  }

  async softDeleteCourse(id: string): Promise<boolean> {
    return await AppDataSource.transaction(async (manager) => {
      const courseRes = await manager.softDelete(Course, id);
      const topics = await manager.find(Topic, { where: { courseId: id } });
      const topicIds = topics.map((t) => t.id);

      if (topicIds.length > 0) {
        await manager.softDelete(Subtopic, { topicId: In(topicIds) });
      }
      await manager.softDelete(Topic, { courseId: id });
      await manager.softDelete(Assignment, { courseId: id });

      return (courseRes.affected ?? 0) > 0;
    });
  }

  getCourseImpact(courseId: string): Promise<CourseImpactInfo> {
    // When allocations module is implemented, count will be fetched via allocationsRepository
    return Promise.resolve({
      courseId,
      openAllocationsCount: 0,
      affectedMenteesCount: 0,
    });
  }

  // --- Topic Operations ---
  async createTopic(data: Partial<Topic>): Promise<Topic> {
    return await AppDataSource.transaction(async (manager) => {
      let displayOrder = data.displayOrder;
      if (displayOrder === undefined && data.courseId) {
        await manager
          .getRepository(Course)
          .createQueryBuilder('course')
          .setLock('pessimistic_write')
          .where('course.id = :id', { id: data.courseId })
          .getOne();

        const maxRow = await manager
          .getRepository(Topic)
          .createQueryBuilder('topic')
          .select('COALESCE(MAX(topic.displayOrder), -1)', 'max')
          .where('topic.courseId = :courseId', { courseId: data.courseId })
          .andWhere('topic.deletedAt IS NULL')
          .getRawOne<{ max?: string | number | null }>();

        displayOrder = Number(maxRow?.max ?? -1) + 1;
      }

      const topicRepo = manager.getRepository(Topic);
      const topic = topicRepo.create({ ...data, displayOrder });
      return await topicRepo.save(topic);
    });
  }

  async findTopicById(id: string): Promise<Topic | null> {
    const topic = await this.topicRepo.findOne({
      where: { id },
    });

    if (!topic) {
      return null;
    }

    const subtopics = await this.subtopicRepo.find({
      where: { topicId: id },
      order: { displayOrder: 'ASC' },
    });

    const assignments = await this.assignmentRepo.find({
      where: { topicId: id },
      order: { displayOrder: 'ASC' },
    });

    topic.subtopics = subtopics;
    topic.assignments = assignments;

    return topic;
  }

  async updateTopic(
    id: string,
    data: Partial<Topic>,
    expectedUpdatedAt?: string,
  ): Promise<Topic | null> {
    const qb = this.topicRepo
      .createQueryBuilder()
      .update(Topic)
      .set({ ...data, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('deletedAt IS NULL');

    if (expectedUpdatedAt) {
      qb.andWhere(
        "date_trunc('milliseconds', updatedAt) = date_trunc('milliseconds', :expectedUpdatedAt::timestamptz)",
        { expectedUpdatedAt },
      );
    }

    const res = await qb.execute();
    if (res.affected === 0) {
      const exists = await this.topicRepo.findOne({ where: { id } });
      if (!exists) {
        return null;
      }
      throw new ConflictError(
        'This item was modified concurrently by another user. Please reload the latest changes.',
      );
    }
    return await this.topicRepo.findOne({ where: { id } });
  }

  async deleteTopic(id: string): Promise<boolean> {
    return await AppDataSource.transaction(async (manager) => {
      const topicRes = await manager.softDelete(Topic, id);
      await manager.softDelete(Subtopic, { topicId: id });
      await manager.softDelete(Assignment, { topicId: id });
      return (topicRes.affected ?? 0) > 0;
    });
  }

  async getNextTopicOrder(courseId: string): Promise<number> {
    const maxRow = await this.topicRepo
      .createQueryBuilder('topic')
      .select('COALESCE(MAX(topic.displayOrder), -1)', 'max')
      .where('topic.courseId = :courseId', { courseId })
      .andWhere('topic.deletedAt IS NULL')
      .getRawOne<{ max?: string | number | null }>();
    return Number(maxRow?.max ?? -1) + 1;
  }

  async reorderTopics(
    courseId: string,
    items: { id: string; displayOrder: number }[],
  ): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      let affected = 0;
      for (const item of items) {
        const res = await manager.update(
          Topic,
          { id: item.id, courseId, deletedAt: IsNull() },
          { displayOrder: item.displayOrder },
        );
        affected += res.affected ?? 0;
      }
      if (affected !== items.length) {
        throw new ValidationError('One or more items do not belong to this course');
      }
    });
  }

  // --- Subtopic Operations ---
  async createSubtopic(data: Partial<Subtopic>): Promise<Subtopic> {
    return await AppDataSource.transaction(async (manager) => {
      let displayOrder = data.displayOrder;
      if (displayOrder === undefined && data.topicId) {
        await manager
          .getRepository(Topic)
          .createQueryBuilder('topic')
          .setLock('pessimistic_write')
          .where('topic.id = :id', { id: data.topicId })
          .getOne();

        const maxRow = await manager
          .getRepository(Subtopic)
          .createQueryBuilder('subtopic')
          .select('COALESCE(MAX(subtopic.displayOrder), -1)', 'max')
          .where('subtopic.topicId = :topicId', { topicId: data.topicId })
          .andWhere('subtopic.deletedAt IS NULL')
          .getRawOne<{ max?: string | number | null }>();

        displayOrder = Number(maxRow?.max ?? -1) + 1;
      }

      const subtopicRepo = manager.getRepository(Subtopic);
      const subtopic = subtopicRepo.create({ ...data, displayOrder });
      return await subtopicRepo.save(subtopic);
    });
  }

  async findSubtopicById(id: string): Promise<Subtopic | null> {
    return await this.subtopicRepo.findOne({ where: { id } });
  }

  async updateSubtopic(
    id: string,
    data: Partial<Subtopic>,
    expectedUpdatedAt?: string,
  ): Promise<Subtopic | null> {
    const qb = this.subtopicRepo
      .createQueryBuilder()
      .update(Subtopic)
      .set({ ...data, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('deletedAt IS NULL');

    if (expectedUpdatedAt) {
      qb.andWhere(
        "date_trunc('milliseconds', updatedAt) = date_trunc('milliseconds', :expectedUpdatedAt::timestamptz)",
        { expectedUpdatedAt },
      );
    }

    const res = await qb.execute();
    if (res.affected === 0) {
      const exists = await this.subtopicRepo.findOne({ where: { id } });
      if (!exists) {
        return null;
      }
      throw new ConflictError(
        'This item was modified concurrently by another user. Please reload the latest changes.',
      );
    }
    return await this.subtopicRepo.findOne({ where: { id } });
  }

  async deleteSubtopic(id: string): Promise<boolean> {
    const res = await this.subtopicRepo.softDelete(id);
    return (res.affected ?? 0) > 0;
  }

  async getNextSubtopicOrder(topicId: string): Promise<number> {
    const maxRow = await this.subtopicRepo
      .createQueryBuilder('subtopic')
      .select('COALESCE(MAX(subtopic.displayOrder), -1)', 'max')
      .where('subtopic.topicId = :topicId', { topicId })
      .andWhere('subtopic.deletedAt IS NULL')
      .getRawOne<{ max?: string | number | null }>();
    return Number(maxRow?.max ?? -1) + 1;
  }

  async reorderSubtopics(
    topicId: string,
    items: { id: string; displayOrder: number }[],
  ): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      let affected = 0;
      for (const item of items) {
        const res = await manager.update(
          Subtopic,
          { id: item.id, topicId, deletedAt: IsNull() },
          { displayOrder: item.displayOrder },
        );
        affected += res.affected ?? 0;
      }
      if (affected !== items.length) {
        throw new ValidationError('One or more items do not belong to this topic');
      }
    });
  }

  // --- Assignment Operations ---
  async createAssignment(data: Partial<Assignment>): Promise<Assignment> {
    return await AppDataSource.transaction(async (manager) => {
      let displayOrder = data.displayOrder;
      if (displayOrder === undefined && data.courseId) {
        await manager
          .getRepository(Course)
          .createQueryBuilder('course')
          .setLock('pessimistic_write')
          .where('course.id = :id', { id: data.courseId })
          .getOne();

        const qb = manager
          .getRepository(Assignment)
          .createQueryBuilder('assignment')
          .select('COALESCE(MAX(assignment.displayOrder), -1)', 'max')
          .where('assignment.courseId = :courseId', { courseId: data.courseId })
          .andWhere('assignment.scope = :scope', { scope: data.scope })
          .andWhere('assignment.deletedAt IS NULL');

        if (data.scope === AssignmentScope.TOPIC && data.topicId) {
          qb.andWhere('assignment.topicId = :topicId', { topicId: data.topicId });
        } else {
          qb.andWhere('assignment.topicId IS NULL');
        }

        const maxRow = await qb.getRawOne<{ max?: string | number | null }>();
        displayOrder = Number(maxRow?.max ?? -1) + 1;
      }

      const assignmentRepo = manager.getRepository(Assignment);
      const assignment = assignmentRepo.create({ ...data, displayOrder });
      return await assignmentRepo.save(assignment);
    });
  }

  async findAssignmentById(id: string): Promise<Assignment | null> {
    return await this.assignmentRepo.findOne({ where: { id } });
  }

  async updateAssignment(
    id: string,
    data: Partial<Assignment>,
    expectedUpdatedAt?: string,
  ): Promise<Assignment | null> {
    const qb = this.assignmentRepo
      .createQueryBuilder()
      .update(Assignment)
      .set({ ...data, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('deletedAt IS NULL');

    if (expectedUpdatedAt) {
      qb.andWhere(
        "date_trunc('milliseconds', updatedAt) = date_trunc('milliseconds', :expectedUpdatedAt::timestamptz)",
        { expectedUpdatedAt },
      );
    }

    const res = await qb.execute();
    if (res.affected === 0) {
      const exists = await this.assignmentRepo.findOne({ where: { id } });
      if (!exists) {
        return null;
      }
      throw new ConflictError(
        'This item was modified concurrently by another user. Please reload the latest changes.',
      );
    }
    return await this.assignmentRepo.findOne({ where: { id } });
  }

  async deleteAssignment(id: string): Promise<boolean> {
    const res = await this.assignmentRepo.softDelete(id);
    return (res.affected ?? 0) > 0;
  }

  async getNextAssignmentOrder(
    courseId: string,
    scope: string,
    topicId?: string | null,
  ): Promise<number> {
    const qb = this.assignmentRepo
      .createQueryBuilder('assignment')
      .select('COALESCE(MAX(assignment.displayOrder), -1)', 'max')
      .where('assignment.courseId = :courseId', { courseId })
      .andWhere('assignment.scope = :scope', { scope })
      .andWhere('assignment.deletedAt IS NULL');

    if (topicId) {
      qb.andWhere('assignment.topicId = :topicId', { topicId });
    } else {
      qb.andWhere('assignment.topicId IS NULL');
    }

    const maxRow = await qb.getRawOne<{ max?: string | number | null }>();
    return Number(maxRow?.max ?? -1) + 1;
  }

  async reorderAssignments(
    courseId: string,
    items: { id: string; displayOrder: number }[],
  ): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      let affected = 0;
      for (const item of items) {
        const res = await manager.update(
          Assignment,
          { id: item.id, courseId, deletedAt: IsNull() },
          { displayOrder: item.displayOrder },
        );
        affected += res.affected ?? 0;
      }
      if (affected !== items.length) {
        throw new ValidationError('One or more items do not belong to this course');
      }
    });
  }
}

export const coursesRepository = new CoursesRepository();
