import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { envSchema } from '../../src/core/config';

void describe('Configuration Schema Validation Tests', () => {
  const dummySecret = '01234567890123456789012345678901';
  const baseValidProductionEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    DIRECT_URL: 'postgres://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: dummySecret,
    JWT_REFRESH_SECRET: dummySecret,
  };

  void it('fails validation in production when EMAIL_PROVIDER is sendgrid and SENDGRID_API_KEY is missing', () => {
    const result = envSchema.safeParse({
      ...baseValidProductionEnv,
      EMAIL_PROVIDER: 'sendgrid',
    });

    assert.strictEqual(result.success, false);
    if (!result.success) {
      const apiKeyIssue = result.error.issues.find((issue) =>
        issue.path.includes('SENDGRID_API_KEY'),
      );
      assert.notStrictEqual(apiKeyIssue, undefined);
      assert.match(apiKeyIssue!.message, /SENDGRID_API_KEY is required in production/);
    }
  });

  void it('succeeds in production when EMAIL_PROVIDER is sendgrid and SENDGRID_API_KEY is provided', () => {
    const result = envSchema.safeParse({
      ...baseValidProductionEnv,
      EMAIL_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'SG.test-api-key',
    });

    assert.strictEqual(result.success, true);
  });

  void it('fails validation in production when EMAIL_PROVIDER is smtp and SMTP_HOST is missing', () => {
    const result = envSchema.safeParse({
      ...baseValidProductionEnv,
      EMAIL_PROVIDER: 'smtp',
    });

    assert.strictEqual(result.success, false);
    if (!result.success) {
      const smtpHostIssue = result.error.issues.find((issue) => issue.path.includes('SMTP_HOST'));
      assert.notStrictEqual(smtpHostIssue, undefined);
      assert.match(smtpHostIssue!.message, /SMTP_HOST is required in production/);
    }
  });

  void it('succeeds in production when EMAIL_PROVIDER is smtp and SMTP_HOST is provided', () => {
    const result = envSchema.safeParse({
      ...baseValidProductionEnv,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.mailgun.org',
    });

    assert.strictEqual(result.success, true);
  });

  void it('allows missing SENDGRID_API_KEY in non-production environments', () => {
    const result = envSchema.safeParse({
      ...baseValidProductionEnv,
      NODE_ENV: 'development',
      EMAIL_PROVIDER: 'sendgrid',
    });

    assert.strictEqual(result.success, true);
  });
});
