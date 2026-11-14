import type { Request, Response } from 'express';

import { UnauthorizedError } from '../../core/errors';
import { BaseController } from '../../core/http';
import { UserRole } from '../users';
import { BatchService, batchService } from './batch.service';
import {
  AddBatchMembersInput,
  BatchQueryParams,
  ChangeBatchStatusInput,
  CreateBatchInput,
  MapMenteesInput,
  ReassignMenteeInput,
  TransferMenteeInput,
  UpdateBatchInput,
} from './schemas';

export class BatchController extends BaseController {
  constructor(private readonly service: BatchService = batchService) {
    super();
  }

  private getAuthUser(req: Request) {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    return req.user;
  }

  public createBatch = async (req: Request, res: Response): Promise<void> => {
    const user = this.getAuthUser(req);
    const batch = await this.service.createBatch(req.body as CreateBatchInput, user.id);
    this.sendCreated(res, { batch });
  };

  public getBatches = async (req: Request, res: Response): Promise<void> => {
    const user = this.getAuthUser(req);
    const params = req.query as unknown as BatchQueryParams;

    if ((user.role as UserRole) === UserRole.MENTOR) {
      const mentorResult = await this.service.getBatchesForMentor(user.id, params);
      this.sendSuccess(res, mentorResult);
      return;
    }

    const result = await this.service.getBatches(params);
    this.sendSuccess(res, result);
  };

  public getBatchById = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const user = this.getAuthUser(req);

    if ((user.role as UserRole) === UserRole.MENTOR) {
      const result = await this.service.getBatchByIdForMentor(id, user.id);
      this.sendSuccess(res, result);
      return;
    }

    const result = await this.service.getBatchById(id);
    this.sendSuccess(res, result);
  };

  public updateBatch = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const user = this.getAuthUser(req);
    const batch = await this.service.updateBatch(id, req.body as UpdateBatchInput, user.id);
    this.sendSuccess(res, { batch });
  };

  public changeBatchStatus = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const user = this.getAuthUser(req);
    const batch = await this.service.changeBatchStatus(
      id,
      req.body as ChangeBatchStatusInput,
      user.id,
    );
    this.sendSuccess(res, { batch });
  };

  public addMembers = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const user = this.getAuthUser(req);
    const members = await this.service.addMembers(id, req.body as AddBatchMembersInput, user.id);
    this.sendCreated(res, { members });
  };

  public removeMember = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const userId = String(req.params.userId);
    const user = this.getAuthUser(req);
    await this.service.removeMember(id, userId, user.id);
    this.sendSuccess(res, { message: 'Member removed successfully' });
  };

  public transferMentee = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const user = this.getAuthUser(req);
    const membership = await this.service.transferMentee(
      id,
      req.body as TransferMenteeInput,
      user.id,
    );
    this.sendCreated(res, { membership });
  };

  // --- Mentor-Mentee Mappings ---

  public mapMentees = async (req: Request, res: Response): Promise<void> => {
    const user = this.getAuthUser(req);
    const id = String(req.params.id);
    const mappings = await this.service.mapMentees(id, req.body as MapMenteesInput, user.id);
    this.sendCreated(res, { mappings });
  };

  public reassignMentee = async (req: Request, res: Response): Promise<void> => {
    const user = this.getAuthUser(req);
    const id = String(req.params.id);
    const mapping = await this.service.reassignMentee(id, req.body as ReassignMenteeInput, user.id);
    this.sendCreated(res, { mapping });
  };

  public getBatchMappings = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const mappings = await this.service.getBatchMappings(id);
    this.sendSuccess(res, { mappings });
  };

  // --- Mentor and Mentee Specific Views ---

  public getMentorMentees = async (req: Request, res: Response): Promise<void> => {
    const user = this.getAuthUser(req);
    const query = req.query as unknown as { batchId?: string; batchIds?: string | string[] };
    const batchIdOrIds =
      query.batchIds ?? (typeof req.query.batchId === 'string' ? req.query.batchId : undefined);
    const mentees = await this.service.getMenteesForMentor(user.id, batchIdOrIds);
    this.sendSuccess(res, { mentees });
  };

  public getMyBatch = async (req: Request, res: Response): Promise<void> => {
    const user = this.getAuthUser(req);
    const result = await this.service.getBatchForMentee(user.id);
    this.sendSuccess(res, result);
  };
}

export const batchController = new BatchController();
