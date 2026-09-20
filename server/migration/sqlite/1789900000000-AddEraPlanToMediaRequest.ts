import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEraPlanToMediaRequest1789900000000 implements MigrationInterface {
  name = 'AddEraPlanToMediaRequest1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "eraPlan" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "eraPlan"`
    );
  }
}
