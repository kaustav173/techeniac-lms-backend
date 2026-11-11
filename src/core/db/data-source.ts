import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { env } from '../config';
import { baseDataSourceOptions } from './data-source.options';

// TLS is configured by the connection string: Neon → ?sslmode=verify-full, local Postgres → ?sslmode=disable
export const AppDataSource = new DataSource({
  ...baseDataSourceOptions,
  url: env.DATABASE_URL,
  logging: env.LOG_LEVEL === 'debug',
  extra: {
    max: 10,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 25000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  },
});
