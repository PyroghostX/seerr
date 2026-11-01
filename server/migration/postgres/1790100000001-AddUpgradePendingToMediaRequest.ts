import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpgradePendingToMediaRequest1790100000001 implements MigrationInterface {
  name = 'AddUpgradePendingToMediaRequest1790100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "upgradePending" boolean NOT NULL DEFAULT false`
    );
    // Upgrades from the last few days are likely still downloading
    await queryRunner.query(
      `UPDATE "media_request" SET "upgradePending" = true WHERE "isUpgrade" = true AND "status" = 5 AND "createdAt" >= now() - interval '3 days'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "upgradePending"`
    );
  }
}
