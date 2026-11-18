import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodObject } from 'zod';

import { ValidationError } from '../errors';

export function validate(
  schema: ZodObject,
): (req: Request, _res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = (await schema.parseAsync({
        body: req.body as unknown,
        query: req.query as unknown,
        params: req.params as unknown,
      })) as { body?: unknown; query?: unknown; params?: unknown };

      if (parsed.body !== undefined) {
        req.body = parsed.body;
      }
      if (parsed.query !== undefined) {
        Object.defineProperty(req, 'query', {
          value: parsed.query,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      if (parsed.params !== undefined) {
        Object.defineProperty(req, 'params', {
          value: parsed.params,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const fieldErrors = error.issues.map((err) => ({
          field: err.path.slice(1).join('.') || err.path.join('.'),
          message: err.message,
        }));
        next(new ValidationError('Validation failed', fieldErrors));
        return;
      }
      next(error);
    }
  };
}
