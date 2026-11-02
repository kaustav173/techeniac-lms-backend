import 'reflect-metadata';

import { hashPassword } from '../src/core/auth';
import { closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';
import { passwordValidation } from '../src/modules/auth/schemas/auth.schemas';
import { UserRole } from '../src/modules/users';
import { userRepository } from '../src/modules/users/user.repository';

async function seedAdmin(): Promise<void> {
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Super Admin';
  const email = process.env.SEED_ADMIN_EMAIL?.trim() || 'admin@TechEniac.com';
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!password) {
    logger.error('SEED_ADMIN_PASSWORD environment variable is required.');
    process.exit(1);
  }

  const validationResult = passwordValidation.safeParse(password);
  if (!validationResult.success) {
    const errorMsg =
      validationResult.error.errors[0]?.message ??
      'Password does not meet complexity requirements.';
    logger.error({ reason: errorMsg }, 'SEED_ADMIN_PASSWORD does not meet security requirements.');
    process.exit(1);
  }

  logger.info('Starting Super Admin seed script...');

  await initializeDatabase();

  const passwordHash = await hashPassword(password);

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) {
    if (!existingUser.isActive || existingUser.role !== UserRole.SUPER_ADMIN) {
      existingUser.isActive = true;
      existingUser.role = UserRole.SUPER_ADMIN;
      await userRepository.save(existingUser);
    }
    await userRepository.updatePassword(existingUser.id, passwordHash);
    logger.info(
      { id: existingUser.id, role: existingUser.role },
      'Super Admin user already exists. Verified active status and updated password to match SEED_ADMIN_PASSWORD.',
    );
    await closeDatabase();
    return;
  }

  const admin = await userRepository.create({
    name,
    email,
    passwordHash,
    role: UserRole.SUPER_ADMIN,
    mustChangePassword: true,
  });

  logger.info({ id: admin.id, role: admin.role }, 'Super Admin seeded successfully.');
  await closeDatabase();
}

async function run(): Promise<void> {
  try {
    await seedAdmin();
  } catch (err) {
    logger.error({ err }, 'Failed to seed Super Admin.');
    try {
      await closeDatabase();
    } catch {
      // Ignore database close errors during fatal process failure
    }
    process.exit(1);
  }
}

void run();
