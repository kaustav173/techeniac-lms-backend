import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIpAndCountryToAuditLogsTable1792650650000 implements MigrationInterface {
  name = 'AddIpAndCountryToAuditLogsTable1792650650000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
      ADD COLUMN IF NOT EXISTS "ip_address" character varying(45),
      ADD COLUMN IF NOT EXISTS "country" character varying(100);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
      DROP COLUMN IF EXISTS "country",
      DROP COLUMN IF EXISTS "ip_address";
    `);
  }
}
