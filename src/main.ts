import dns from 'node:dns';

import { app } from './app';
import { env } from './core/config';
import { closeDatabase, initializeDatabase } from './core/db';
import { logger } from './core/logging';
import { closeScheduledJobs, registerScheduledJobs } from './jobs';

// Ensure IPv4 is preferred to prevent AggregateError [ETIMEDOUT] and ENETUNREACH on dual-stack hosts without IPv6 gateways
dns.setDefaultResultOrder('ipv4first');

export async function bootstrap(): Promise<void> {
  try {
    await initializeDatabase();

    // Register BullMQ recurring scheduled jobs and workers without blocking HTTP startup if Redis is unavailable
    try {
      await registerScheduledJobs();
    } catch (jobErr) {
      logger.warn(
        { err: jobErr },
        'Failed to register BullMQ scheduled jobs. Running HTTP server with background jobs disabled.',
      );
    }

    const server = app.listen(env.PORT, (error?: Error) => {
      if (error) {
        logger.error({ err: error }, 'HTTP server failed to start');
        process.exit(1);
      }

      logger.info(
        `Server running in ${env.NODE_ENV} mode on port ${env.PORT} (http://localhost:${env.PORT})`,
      );
    });

    server.on('error', (err: Error) => {
      logger.error({ err }, 'HTTP server encountered a runtime error');
      process.exit(1);
    });

    const shutdown = (signal: string): void => {
      logger.info(`Received ${signal}. Initiating graceful shutdown...`);

      server.close(() => {
        logger.info('HTTP server closed.');
        void (async () => {
          try {
            await closeScheduledJobs();
            await closeDatabase();
            logger.info('Graceful shutdown completed successfully.');
            process.exit(0);
          } catch (err) {
            logger.error({ err }, 'Error closing resources during shutdown');
            process.exit(1);
          }
        })();
      });

      setTimeout(() => {
        logger.error('Graceful shutdown timed out. Forcing process termination.');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  } catch (err) {
    logger.error({ err }, 'Application bootstrap failed');
    process.exit(1);
  }
}

void bootstrap();
