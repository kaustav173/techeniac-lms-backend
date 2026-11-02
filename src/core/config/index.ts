import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { logger } from '../logging';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    DATABASE_URL: z.string().url().startsWith('postgres'),
    DIRECT_URL: z.string().url().startsWith('postgres'),
    TEST_DATABASE_URL: z.string().optional(),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((val) =>
        val
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url())),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    COMMIT_SHA: z
      .string()
      .optional()
      .transform((val) => (val && val.trim().length > 0 ? val.trim() : 'local-dev')),
    JWT_ACCESS_SECRET: z
      .string({ required_error: 'JWT_ACCESS_SECRET is required' })
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters long'),
    JWT_REFRESH_SECRET: z
      .string({ required_error: 'JWT_REFRESH_SECRET is required' })
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters long'),
    JWT_ALGORITHM: z.literal('HS256').default('HS256'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL: z.string().default('7d'),
    FRONTEND_URL: z.string().url().default('http://localhost:3000'),
    EMAIL_PROVIDER: z.enum(['sendgrid', 'smtp']).default('sendgrid'),
    SENDGRID_API_KEY: z.string().optional(),
    SENDGRID_FROM_EMAIL: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: z
      .string()
      .optional()
      .transform((val) => val === 'true' || val === '1')
      .pipe(z.boolean()),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('Techeniac LMS <noreply@techeniac.com>'),
    REDIS_URL: z.string().optional(),
    REDIS_HOST: z.string().default('127.0.0.1'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (data.EMAIL_PROVIDER === 'sendgrid' && !data.SENDGRID_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SENDGRID_API_KEY'],
          message:
            'SENDGRID_API_KEY is required in production environment when EMAIL_PROVIDER is sendgrid',
        });
      } else if (data.EMAIL_PROVIDER === 'smtp' && !data.SMTP_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_HOST'],
          message: 'SMTP_HOST is required in production environment when EMAIL_PROVIDER is smtp',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errorDetails = result.error.errors
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');

    logger.error(`Environment configuration validation failed:\n${errorDetails}`);
    process.exit(1);
  }

  logger.level = result.data.LOG_LEVEL;
  return Object.freeze(result.data);
}

export const env = loadEnv();
export * from './grade-scale';
