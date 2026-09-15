import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsUpgradeToMediaRequest1789600000001 implements MigrationInterface {
  name = 'AddIsUpgradeToMediaRequest1789600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "isUpgrade" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "isUpgrade"`
    );
  }
}
