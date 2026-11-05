import { AuditRepository, auditRepository, CreateAuditLogData } from './audit.repository';
import { AuditLogType } from './entities/audit.enums';
import { AuditLog } from './entities/audit-log.entity';
import { AuditQueryParams } from './schemas/audit.schemas';

export class AuditService {
  private repository: AuditRepository | null;

  constructor(repository?: AuditRepository) {
    this.repository = repository ?? null;
  }

  private get repo(): AuditRepository {
    if (!this.repository) {
      this.repository = auditRepository;
    }
    return this.repository;
  }

  public async record(data: CreateAuditLogData): Promise<AuditLog> {
    return this.repo.create(data);
  }

  public async getAuditLogs(params: AuditQueryParams) {
    const page = Math.max(1, Number(params?.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params?.limit) || 10));

    const { items, total } = await this.repo.findWithFilters({
      ...params,
      page,
      limit,
    });
    const totalPages = Math.ceil(total / limit);

    const enrichedItems = await this.enrichAuditItems(items);

    return {
      items: enrichedItems,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  private async enrichAuditItems(items: AuditLog[]): Promise<AuditLog[]> {
    if (!items || items.length === 0) return items;

    const allocationIds = new Set<string>();
    const submissionIds = new Set<string>();
    const userIds = new Set<string>();
    const courseIds = new Set<string>();
    const batchIds = new Set<string>();
    const assignmentIds = new Set<string>();

    for (const item of items) {
      const val = item.newValue ?? item.oldValue;

      if (item.type === AuditLogType.COURSE_ALLOCATION) {
        if (item.entityId) allocationIds.add(item.entityId);
        if (typeof val?.courseId === 'string' && !val.courseTitle) {
          courseIds.add(val.courseId);
        }
        if (typeof val?.userId === 'string' && !val.userName) {
          userIds.add(val.userId);
        }
      } else if (item.type === AuditLogType.SUBMISSION) {
        if (item.entityId) submissionIds.add(item.entityId);
        if (typeof val?.assignmentId === 'string' && !val.assignmentTitle) {
          assignmentIds.add(val.assignmentId);
        }
      } else if (item.type === AuditLogType.GRADING) {
        if (item.entityId) submissionIds.add(item.entityId);
      } else if (item.type === AuditLogType.MENTOR_MAPPING) {
        if (typeof val?.mentorId === 'string' && !val.mentorName) {
          userIds.add(val.mentorId);
        }
        if (typeof val?.menteeId === 'string' && !val.menteeName) {
          userIds.add(val.menteeId);
        }
      } else if (item.type === AuditLogType.COURSE) {
        if (item.entityId && (!val || !val.title)) {
          courseIds.add(item.entityId);
        }
      } else if (item.type === AuditLogType.BATCH) {
        if (item.entityId && (!val || !val.name)) {
          batchIds.add(item.entityId);
        }
      } else if (item.type === AuditLogType.USER || item.type === AuditLogType.AUTH) {
        if (item.entityId && (!val || (!val.name && !val.email))) {
          userIds.add(item.entityId);
        }
      }
    }

    const batchData = await this.repo.findTargetEntitiesBatch({
      allocationIds: Array.from(allocationIds),
      submissionIds: Array.from(submissionIds),
      courseIds: Array.from(courseIds),
      userIds: Array.from(userIds),
      batchIds: Array.from(batchIds),
      assignmentIds: Array.from(assignmentIds),
    });

    for (const item of items) {
      const val = item.newValue ?? item.oldValue ?? {};

      if (item.type === AuditLogType.COURSE_ALLOCATION) {
        const alloc = item.entityId ? batchData.allocations.get(item.entityId) : undefined;
        const courseTitle =
          (val.courseTitle as string | undefined) ||
          alloc?.courseTitle ||
          (typeof val.courseId === 'string' ? batchData.courses.get(val.courseId) : undefined);
        const userName =
          (val.userName as string | undefined) ||
          alloc?.userName ||
          (typeof val.userId === 'string' ? batchData.users.get(val.userId)?.name : undefined);

        item.newValue = {
          ...item.newValue,
          courseTitle: courseTitle ?? null,
          userName: userName ?? null,
        };
      } else if (item.type === AuditLogType.SUBMISSION) {
        const sub = item.entityId ? batchData.submissions.get(item.entityId) : undefined;
        const assignmentTitle =
          (val.assignmentTitle as string | undefined) ||
          sub?.assignmentTitle ||
          (typeof val.assignmentId === 'string'
            ? batchData.assignments.get(val.assignmentId)
            : undefined);
        const studentName = (val.userName as string | undefined) || sub?.studentName;

        item.newValue = {
          ...item.newValue,
          assignmentTitle: assignmentTitle ?? null,
          userName: studentName ?? null,
        };
      } else if (item.type === AuditLogType.GRADING) {
        const sub = item.entityId ? batchData.submissions.get(item.entityId) : undefined;
        const studentName =
          (val.studentName as string | undefined) ||
          sub?.studentName ||
          (typeof val.userId === 'string' ? batchData.users.get(val.userId)?.name : undefined);
        const studentEmail = (val.studentEmail as string | undefined) || sub?.studentEmail;
        const assignmentTitle = (val.assignmentTitle as string | undefined) || sub?.assignmentTitle;
        const gradeLabel = (val.gradeLabel as string | undefined) || sub?.gradeLabel;

        let computedGrade = gradeLabel ?? null;
        const marksStr =
          typeof val.marks === 'number' || typeof val.marks === 'string' ? String(val.marks) : null;
        if (!computedGrade && marksStr) {
          computedGrade = `Marks: ${marksStr}`;
        }

        item.newValue = {
          ...item.newValue,
          studentName: studentName ?? null,
          studentEmail: studentEmail ?? null,
          assignmentTitle: assignmentTitle ?? null,
          gradeLabel: computedGrade,
        };
      } else if (item.type === AuditLogType.MENTOR_MAPPING) {
        const mentorName =
          (val.mentorName as string | undefined) ||
          (typeof val.mentorId === 'string' ? batchData.users.get(val.mentorId)?.name : undefined);
        const menteeName =
          (val.menteeName as string | undefined) ||
          (typeof val.menteeId === 'string' ? batchData.users.get(val.menteeId)?.name : undefined);

        item.newValue = {
          ...item.newValue,
          mentorName: mentorName ?? null,
          menteeName: menteeName ?? null,
        };
      } else if (item.type === AuditLogType.COURSE) {
        const title =
          (val.title as string | undefined) ||
          (item.entityId ? batchData.courses.get(item.entityId) : undefined);

        if (title) {
          item.newValue = {
            ...item.newValue,
            title,
          };
        }
      } else if (item.type === AuditLogType.BATCH) {
        const name =
          (val.name as string | undefined) ||
          (item.entityId ? batchData.batches.get(item.entityId) : undefined);

        if (name) {
          item.newValue = {
            ...item.newValue,
            name,
          };
        }
      } else if (item.type === AuditLogType.USER || item.type === AuditLogType.AUTH) {
        const user = item.entityId ? batchData.users.get(item.entityId) : undefined;
        if (user) {
          item.newValue = {
            ...item.newValue,
            name: (typeof val.name === 'string' ? val.name : undefined) || user.name,
            email: (typeof val.email === 'string' ? val.email : undefined) || user.email,
          };
        }
      }
    }

    return items;
  }
}

export const auditService = new AuditService();
