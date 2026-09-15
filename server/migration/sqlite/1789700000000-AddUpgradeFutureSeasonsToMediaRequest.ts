import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpgradeFutureSeasonsToMediaRequest1789700000000 implements MigrationInterface {
  name = 'AddUpgradeFutureSeasonsToMediaRequest1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "upgradeFutureSeasons" boolean NOT NULL DEFAULT (0)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "upgradeFutureSeasons"`
    );
  }
}
