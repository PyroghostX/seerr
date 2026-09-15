import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsUpgradeToMediaRequest1789600000000 implements MigrationInterface {
  name = 'AddIsUpgradeToMediaRequest1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "isUpgrade" boolean NOT NULL DEFAULT (0)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "isUpgrade"`
    );
  }
}
