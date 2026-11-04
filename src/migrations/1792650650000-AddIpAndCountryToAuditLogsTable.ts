import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIpAndCountryToAuditLogsTable1792650650000 implements MigrationInterface {
  name = 'AddIpAndCountryToAuditLogsTable1792650650000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD "ip_address" character varying(45)`);
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD "country" character varying(100)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "country"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "ip_address"`);
  }
}
