import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpgradeFutureSeasonsToMediaRequest1789700000001 implements MigrationInterface {
  name = 'AddUpgradeFutureSeasonsToMediaRequest1789700000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "upgradeFutureSeasons" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "upgradeFutureSeasons"`
    );
  }
}
