import { DataSource, EntityManager, Repository } from 'typeorm';

import { AppDataSource } from '../../core/db';
// eslint-disable-next-line architecture/cross-module-index-imports -- import enum directly to prevent circular barrel initialization between users and batches
import { BatchMemberRole, BatchStatus } from '../batches/entities/batch.enums';
import { User, UserRole } from './entities/user.entity';
import { UserRoleHistory } from './entities/user-role-history.entity';
import type { UserQueryParams } from './users.schemas';

export interface CreateUserData {
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
  mustChangePassword?: boolean;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class UserRepository {
  private readonly repo: Repository<User>;
  private readonly historyRepo: Repository<UserRoleHistory>;

  constructor(private readonly dataSource: DataSource = AppDataSource) {
    this.repo = dataSource.getRepository(User);
    this.historyRepo = dataSource.getRepository(UserRoleHistory);
  }

  public async transaction<T>(
    runInTransaction: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return await this.dataSource.transaction(runInTransaction);
  }

  private getRepo(manager?: EntityManager): Repository<User> {
    return manager ? manager.getRepository(User) : this.repo;
  }

  private getHistoryRepo(manager?: EntityManager): Repository<UserRoleHistory> {
    return manager ? manager.getRepository(UserRoleHistory) : this.historyRepo;
  }

  public async findByEmail(
    email: string,
    options?: { includePassword?: boolean; manager?: EntityManager } | EntityManager,
  ): Promise<User | null> {
    let manager: EntityManager | undefined;
    let includePassword = false;

    if (options) {
      if ('getRepository' in options) {
        manager = options;
      } else {
        manager = options.manager;
        includePassword = Boolean(options.includePassword);
      }
    }

    const repo = this.getRepo(manager);

    if (!includePassword) {
      return await repo.findOne({
        where: { email: email.trim().toLowerCase() },
      });
    }

    return await repo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.email) = :email', { email: email.trim().toLowerCase() })
      .getOne();
  }

  public async findById(
    id: string,
    options?: { includePassword?: boolean; manager?: EntityManager } | EntityManager,
  ): Promise<User | null> {
    let manager: EntityManager | undefined;
    let includePassword = false;

    if (options) {
      if ('getRepository' in options) {
        manager = options;
      } else {
        manager = options.manager;
        includePassword = Boolean(options.includePassword);
      }
    }

    const repo = this.getRepo(manager);

    if (!includePassword) {
      return await repo.findOne({
        where: { id },
      });
    }

    return await repo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id })
      .getOne();
  }

  public async findByEmailWithPassword(
    email: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    return await this.findByEmail(email, { includePassword: true, manager });
  }

  public async findByIdWithPassword(id: string, manager?: EntityManager): Promise<User | null> {
    return await this.findById(id, { includePassword: true, manager });
  }

  public async create(data: CreateUserData, manager?: EntityManager): Promise<User> {
    const repo = this.getRepo(manager);
    const user = repo.create({
      name: data.name.trim(),
      email: data.email.trim().toLowerCase(),
      passwordHash: data.passwordHash,
      role: data.role ?? UserRole.MENTEE,
      ...(data.mustChangePassword !== undefined
        ? { mustChangePassword: data.mustChangePassword }
        : {}),
      tokenVersion: 0,
      isActive: true,
      createdBy: data.createdBy ?? null,
      updatedBy: data.updatedBy ?? null,
    });
    return await repo.save(user);
  }

  public async updateLastLogin(id: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update(id, {
      lastLoginAt: new Date(),
    });
  }

  public async updatePassword(
    id: string,
    passwordHash: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(id, {
      passwordHash,
      mustChangePassword: false,
    });
  }

  public async incrementTokenVersion(id: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).increment({ id }, 'tokenVersion', 1);
  }

  public async findAll(
    params: UserQueryParams,
    manager?: EntityManager,
  ): Promise<[User[], number]> {
    const query = this.getRepo(manager).createQueryBuilder('user').where('user.deleted_at IS NULL');

    if (params.role) {
      query.andWhere('user.role = :role', { role: params.role });
    }

    if (params.status) {
      query.andWhere('user.is_active = :isActive', {
        isActive: params.status === 'active',
      });
    }

    if (params.search) {
      query.andWhere('(user.name ILIKE :search OR user.email ILIKE :search)', {
        search: `%${params.search}%`,
      });
    }

    if (params.batchId) {
      query.andWhere(
        `EXISTS (
          SELECT 1 FROM batch_members bm
          WHERE bm.user_id = "user"."id"
            AND bm.batch_id = :batchId
            AND bm.is_active = true
            AND bm.deleted_at IS NULL
        )`,
        { batchId: params.batchId },
      );
    }

    if (params.mentorId) {
      const mentorIds = params.mentorId
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (mentorIds.length === 1) {
        query.andWhere(
          `EXISTS (
            SELECT 1 FROM mentor_mentees mm
            WHERE mm.mentee_id = "user"."id"
              AND mm.mentor_id = :mentorId
              AND mm.is_active = true
              AND mm.deleted_at IS NULL
          )`,
          { mentorId: mentorIds[0] },
        );
      } else if (mentorIds.length > 1) {
        query.andWhere(
          `EXISTS (
            SELECT 1 FROM mentor_mentees mm
            WHERE mm.mentee_id = "user"."id"
              AND mm.mentor_id IN (:...mentorIds)
              AND mm.is_active = true
              AND mm.deleted_at IS NULL
          )`,
          { mentorIds },
        );
      }
    }

    if (params.withoutActiveBatch !== undefined) {
      const activeBatchSubquery = `
        SELECT 1 FROM batch_members bm
        INNER JOIN batches b ON b.id = bm.batch_id
        WHERE bm.user_id = "user"."id"
          AND bm.member_role = '${BatchMemberRole.MENTEE}'
          AND bm.is_active = true
          AND bm.deleted_at IS NULL
          AND b.status IN ('${BatchStatus.DRAFT}', '${BatchStatus.LIVE}', '${BatchStatus.ON_HOLD}')
          AND b.deleted_at IS NULL
      `;
      if (params.withoutActiveBatch) {
        query.andWhere(`NOT EXISTS (${activeBatchSubquery})`);
      } else {
        query.andWhere(`EXISTS (${activeBatchSubquery})`);
      }
    }

    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 10));

    query
      .orderBy('user.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    return await query.getManyAndCount();
  }

  public async getCounts(manager?: EntityManager): Promise<{
    total: number;
    active: number;
    inactive: number;
  }> {
    const repo = this.getRepo(manager);
    const [total, active] = await Promise.all([
      repo.count(),
      repo.count({ where: { isActive: true } }),
    ]);
    return {
      total,
      active,
      inactive: Math.max(0, total - active),
    };
  }

  public async lockAndCountActiveSuperAdmins(manager?: EntityManager): Promise<number> {
    const rows = await this.getRepo(manager)
      .createQueryBuilder('user')
      .setLock('pessimistic_write')
      .where('user.role = :role AND user.is_active = true AND user.deleted_at IS NULL', {
        role: UserRole.SUPER_ADMIN,
      })
      .getMany();
    return rows.length;
  }

  public async save(user: User, manager?: EntityManager): Promise<User> {
    return await this.getRepo(manager).save(user);
  }

  public async saveRoleHistory(
    history: Partial<UserRoleHistory>,
    manager?: EntityManager,
  ): Promise<UserRoleHistory> {
    const record = this.getHistoryRepo(manager).create(history);
    return await this.getHistoryRepo(manager).save(record);
  }

  public async closeActiveRoleHistory(
    userId: string,
    toAt: Date = new Date(),
    manager?: EntityManager,
  ): Promise<void> {
    await this.getHistoryRepo(manager)
      .createQueryBuilder()
      .update(UserRoleHistory)
      .set({ toAt })
      .where('user_id = :userId AND to_at IS NULL AND deleted_at IS NULL', { userId })
      .execute();
  }
}

export const userRepository = new UserRepository();
export { UserRepository as UsersRepository, userRepository as usersRepository };
