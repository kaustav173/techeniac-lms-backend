import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { AuthenticatedUser } from '../../src/core/auth';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/core/errors';
import { sanitizeHtml } from '../../src/core/utils/sanitizer';
import {
  type Assignment,
  type Course,
  coursesRepository,
  coursesService,
  resourceItemSchema,
  SubmissionMode,
  type Subtopic,
  type Topic,
} from '../../src/modules/courses';

type InternalCoursesService = {
  assertCanEdit: (course: Course, user: AuthenticatedUser) => void;
};

const createTestUser = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@TechEniac.com',
  role: 'MENTOR',
  mustChangePassword: false,
  tokenVersion: 1,
  ...overrides,
});

void describe('CoursesService Unit Tests', () => {
  void describe('assertCanEdit Authorization Guard (CRS-18)', () => {
    const course = {
      id: 'course-123',
      createdBy: 'mentor-1-id',
    } as Course;

    const superAdmin = createTestUser({
      id: 'admin-1-id',
      name: 'Super Admin',
      email: 'admin@TechEniac.com',
      role: 'SUPER_ADMIN',
    });

    const courseCreator = createTestUser({
      id: 'mentor-1-id',
      name: 'Mentor Creator',
      email: 'creator@TechEniac.com',
      role: 'MENTOR',
    });

    const anotherMentor = createTestUser({
      id: 'mentor-2-id',
      name: 'Another Mentor',
      email: 'other@TechEniac.com',
      role: 'MENTOR',
    });

    const mentee = createTestUser({
      id: 'mentee-1-id',
      name: 'Mentee User',
      email: 'mentee@TechEniac.com',
      role: 'MENTEE',
    });

    const service = coursesService as unknown as InternalCoursesService;

    void it('allows SUPER_ADMIN to modify any course', () => {
      assert.doesNotThrow(() => {
        service.assertCanEdit(course, superAdmin);
      });
    });

    void it('allows MENTOR who created the course to modify it', () => {
      assert.doesNotThrow(() => {
        service.assertCanEdit(course, courseCreator);
      });
    });

    void it('allows another MENTOR who did not create the course to modify it (collaborative editing)', () => {
      assert.doesNotThrow(() => {
        service.assertCanEdit(course, anotherMentor);
      });
    });

    void it('rejects MENTEE with ForbiddenError', () => {
      assert.throws(() => {
        service.assertCanEdit(course, mentee);
      }, ForbiddenError);
    });
  });

  void describe('Budget Mathematics & Constraints', () => {
    const user = createTestUser({
      id: 'mentor-1-id',
      name: 'Mentor Creator',
      email: 'creator@TechEniac.com',
      role: 'MENTOR',
    });

    void it('rejects reducing course duration below total duration of its topics', async () => {
      const mockCourse = {
        id: 'c1',
        title: 'Fullstack Course',
        createdBy: user.id,
        updatedAt: new Date(),
        estimatedMinutes: 120,
        topics: [
          { id: 't1', estimatedMinutes: 60 },
          { id: 't2', estimatedMinutes: 40 },
        ] as Topic[],
      } as Course;

      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.updateCourse('c1', { estimatedMinutes: 90 }, user);
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /cannot be less than the total allocated duration/);
          return true;
        },
      );
    });

    void it('rejects creating topic whose duration exceeds course remaining budget', async () => {
      const mockCourse = {
        id: 'c1',
        title: 'Fullstack Course',
        createdBy: user.id,
        updatedAt: new Date(),
        estimatedMinutes: 100,
        topics: [{ id: 't1', estimatedMinutes: 70 }] as Topic[],
      } as Course;

      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.createTopic(
            'c1',
            { title: 'New Topic', estimatedMinutes: 40 },
            user,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /exceeds the course's remaining duration budget/);
          return true;
        },
      );
    });

    void it('rejects updating topic duration below total duration of its subtopics', async () => {
      const mockTopic = {
        id: 't1',
        courseId: 'c1',
        title: 'Topic 1',
        estimatedMinutes: 60,
        updatedAt: new Date(),
        subtopics: [
          { id: 'st1', estimatedMinutes: 30 },
          { id: 'st2', estimatedMinutes: 20 },
        ] as Subtopic[],
      } as Topic;

      const mockCourse = {
        id: 'c1',
        createdBy: user.id,
        topics: [mockTopic],
      } as Course;

      coursesRepository.findTopicById = () => Promise.resolve(mockTopic);
      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.updateTopic('t1', { estimatedMinutes: 40 }, user);
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /cannot be less than the total allocated duration/);
          return true;
        },
      );
    });

    void it('rejects creating subtopic whose duration exceeds topic remaining budget', async () => {
      const mockTopic = {
        id: 't1',
        courseId: 'c1',
        title: 'Topic 1',
        estimatedMinutes: 60,
        subtopics: [{ id: 'st1', estimatedMinutes: 45 }] as Subtopic[],
      } as Topic;

      const mockCourse = {
        id: 'c1',
        createdBy: user.id,
      } as Course;

      coursesRepository.findTopicById = () => Promise.resolve(mockTopic);
      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.createSubtopic(
            't1',
            { title: 'Subtopic 2', estimatedMinutes: 20 },
            user,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /exceeds topic "Topic 1" remaining duration budget/);
          return true;
        },
      );
    });
  });

  void describe('Assignment Marks Merging (CRS-08, FR-6.12)', () => {
    const user = createTestUser({
      id: 'mentor-1-id',
      name: 'Mentor Creator',
      email: 'creator@TechEniac.com',
      role: 'MENTOR',
    });

    const mockAssignment = {
      id: 'assign-1',
      courseId: 'c1',
      maxMarks: 100,
      passMarks: 70,
      updatedAt: new Date(),
    } as Assignment;

    const mockCourse = {
      id: 'c1',
      createdBy: user.id,
    } as Course;

    beforeEach(() => {
      coursesRepository.findAssignmentById = () => Promise.resolve({ ...mockAssignment });
      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);
    });

    void it('rejects updating passMarks alone when it exceeds existing maxMarks', async () => {
      await assert.rejects(
        async () => {
          await coursesService.updateAssignment('assign-1', { passMarks: 110 }, user);
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.equal(err.message, 'Pass marks cannot exceed max marks');
          return true;
        },
      );
    });

    void it('rejects updating maxMarks alone when it is less than existing passMarks', async () => {
      await assert.rejects(
        async () => {
          await coursesService.updateAssignment('assign-1', { maxMarks: 50 }, user);
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.equal(err.message, 'Pass marks cannot exceed max marks');
          return true;
        },
      );
    });

    void it('succeeds when merged passMarks is less than or equal to merged maxMarks', async () => {
      coursesRepository.updateAssignment = (_id, payload) =>
        Promise.resolve({
          ...mockAssignment,
          ...payload,
        });

      const updated = await coursesService.updateAssignment(
        'assign-1',
        { maxMarks: 120, passMarks: 80 },
        user,
      );
      assert.equal(updated.maxMarks, 120);
      assert.equal(updated.passMarks, 80);
    });

    void it('rejects switching all submission modes to OFF in partial update', async () => {
      const mockAssignmentWithModes = {
        id: 'assign-1',
        courseId: 'c1',
        maxMarks: 100,
        passMarks: 70,
        pdfMode: SubmissionMode.OFF,
        zipMode: SubmissionMode.OFF,
        urlMode: SubmissionMode.REQUIRED,
        updatedAt: new Date(),
      } as unknown as Assignment;
      coursesRepository.findAssignmentById = () => Promise.resolve({ ...mockAssignmentWithModes });

      await assert.rejects(
        async () => {
          await coursesService.updateAssignment('assign-1', { urlMode: SubmissionMode.OFF }, user);
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /At least one submission mode/);
          return true;
        },
      );
    });
  });

  void describe('Reordering IDOR Ownership Checks', () => {
    const user = createTestUser({
      id: 'mentor-1-id',
      name: 'Mentor Creator',
      email: 'creator@TechEniac.com',
      role: 'MENTOR',
    });

    void it('rejects reordering topics with a foreign topic ID', async () => {
      const mockCourse = {
        id: 'c1',
        createdBy: user.id,
        topics: [{ id: 'topic-belonging-to-c1' }] as Topic[],
      } as Course;

      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.reorderTopics(
            'c1',
            [{ id: 'foreign-topic-uuid', displayOrder: 0 }],
            user,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /does not belong to this course/);
          return true;
        },
      );
    });

    void it('rejects reordering subtopics with a foreign subtopic ID', async () => {
      const mockTopic = {
        id: 't1',
        courseId: 'c1',
        subtopics: [{ id: 'subtopic-belonging-to-t1' }] as Subtopic[],
      } as Topic;

      const mockCourse = {
        id: 'c1',
        createdBy: user.id,
      } as Course;

      coursesRepository.findTopicById = () => Promise.resolve(mockTopic);
      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.reorderSubtopics(
            't1',
            [{ id: 'foreign-subtopic-uuid', displayOrder: 0 }],
            user,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /does not belong to this topic/);
          return true;
        },
      );
    });

    void it('rejects reordering assignments with a foreign assignment ID', async () => {
      const mockCourse = {
        id: 'c1',
        createdBy: user.id,
        assignments: [{ id: 'assignment-belonging-to-c1' }] as Assignment[],
      } as Course;

      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      await assert.rejects(
        async () => {
          await coursesService.reorderAssignments(
            'c1',
            [{ id: 'foreign-assignment-uuid', displayOrder: 0 }],
            user,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /does not belong to this course/);
          return true;
        },
      );
    });
  });

  void describe('XSS Sanitization & Resource URL Security (M6-XSS-1, CRS-23)', () => {
    void it('strips dangerous event handlers without whitespace like <svg/onload=alert(1)>', () => {
      const payload = '<svg/onload=alert(1)><p>Valid Paragraph</p>';
      const clean = sanitizeHtml(payload);
      assert(!clean.includes('onload'), 'Must strip onload attribute');
      assert(!clean.includes('<svg'), 'Must discard svg tag');
      assert.equal(clean, '<p>Valid Paragraph</p>');
    });

    void it('strips unquoted javascript: href and entity-encoded javascript pseudo-protocols', () => {
      const payload1 = '<a href=javascript:alert(2)>Click me</a>';
      const clean1 = sanitizeHtml(payload1);
      assert(!clean1.includes('javascript:'), 'Must strip javascript: URL');

      const payload2 = '<a href="jav&#x09;ascript:alert(3)">Click me</a>';
      const clean2 = sanitizeHtml(payload2);
      assert(!clean2.includes('javascript'), 'Must strip entity-encoded javascript');
    });

    void it('resourceItemSchema rejects non-http(s) pseudo-protocols in URLs', () => {
      const xssResource = {
        title: 'Malicious Link',
        url: 'javascript:alert(document.cookie)',
        type: 'LINK',
      };
      const result = resourceItemSchema.safeParse(xssResource);
      assert.equal(result.success, false, 'javascript: URL must fail validation');

      const dataUriResource = {
        title: 'Data URI Link',
        url: 'data:text/html,<script>alert(1)</script>',
        type: 'LINK',
      };
      const dataResult = resourceItemSchema.safeParse(dataUriResource);
      assert.equal(dataResult.success, false, 'data: URL must fail validation');

      const validResource = {
        title: 'Safe Link',
        url: 'https://example.com/handbook.pdf',
        type: 'LINK',
      };
      const validResult = resourceItemSchema.safeParse(validResource);
      assert.equal(validResult.success, true, 'https:// URL must pass validation');
    });
  });

  void describe('Optimistic Concurrency Control (M6-OCC-1, FR-6.13)', () => {
    const user = createTestUser({
      id: 'mentor-1',
      role: 'MENTOR',
      email: 'mentor1@example.com',
      tokenVersion: 1,
    });

    void it('throws ConflictError when expectedUpdatedAt does not match actual row timestamp', async () => {
      const mockCourse = {
        id: 'c-occ',
        title: 'Original Title',
        createdBy: user.id,
        updatedAt: new Date('2026-10-26T12:00:00.000Z'),
      } as Course;

      coursesRepository.findCourseById = () => Promise.resolve(mockCourse);

      const staleTimestamp = new Date('2026-10-26T11:00:00.000Z').toISOString();

      await assert.rejects(
        async () => {
          await coursesService.updateCourse(
            'c-occ',
            { title: 'New Title', expectedUpdatedAt: staleTimestamp },
            user,
          );
        },
        (err: unknown) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /modified concurrently by another user/);
          return true;
        },
      );
    });
  });
});
