import { randomUUID } from 'node:crypto';

import type { ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';

import { env } from '../core/config';
import { logger } from '../core/logging';

export const redisConnection: ConnectionOptions = env.REDIS_URL
  ? { url: env.REDIS_URL, maxRetriesPerRequest: null }
  : {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
      maxRetriesPerRequest: null,
    };

export const producerRedisConnection: ConnectionOptions = env.REDIS_URL
  ? { url: env.REDIS_URL, maxRetriesPerRequest: 2 }
  : {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
      maxRetriesPerRequest: 2,
    };

let redisClientInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClientInstance) {
    redisClientInstance = env.REDIS_URL
      ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true })
      : new Redis({
          host: env.REDIS_HOST,
          port: env.REDIS_PORT,
          ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
          maxRetriesPerRequest: 2,
          lazyConnect: true,
        });

    redisClientInstance.on('error', (err) => {
      logger.warn({ err }, 'Redis client encountered an error');
    });
  }
  return redisClientInstance;
}

export function setRedisClient(client: Redis | null): void {
  redisClientInstance = client;
}

export async function closeRedisClient(): Promise<void> {
  if (redisClientInstance) {
    try {
      await redisClientInstance.quit();
    } catch {
      redisClientInstance.disconnect();
    }
    redisClientInstance = null;
  }
}

const EMAIL_CREDENTIAL_PREFIX = 'email:cred:';
const DEFAULT_CREDENTIAL_TTL_SECONDS = 300; // 5 minutes

export async function storeEmailCredential(
  secret: string,
  ttlSeconds = DEFAULT_CREDENTIAL_TTL_SECONDS,
): Promise<string> {
  const key = randomUUID();
  const redis = getRedisClient();
  await redis.set(`${EMAIL_CREDENTIAL_PREFIX}${key}`, secret, 'EX', ttlSeconds);
  return key;
}

export async function retrieveEmailCredential(key: string): Promise<string | null> {
  const redis = getRedisClient();
  return await redis.get(`${EMAIL_CREDENTIAL_PREFIX}${key}`);
}

export async function deleteEmailCredential(key: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.del(`${EMAIL_CREDENTIAL_PREFIX}${key}`);
  } catch {
    // Non-blocking: key will expire automatically per TTL
  }
}
