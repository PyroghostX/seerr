import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpgradePendingToMediaRequest1790100000000 implements MigrationInterface {
  name = 'AddUpgradePendingToMediaRequest1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "upgradePending" boolean NOT NULL DEFAULT (0)`
    );
    // Upgrades from the last few days are likely still downloading
    await queryRunner.query(
      `UPDATE "media_request" SET "upgradePending" = 1 WHERE "isUpgrade" = 1 AND "status" = 5 AND "createdAt" >= datetime('now', '-3 days')`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "upgradePending"`
    );
  }
}
