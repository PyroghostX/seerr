import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEraPlanToMediaRequest1789900000001 implements MigrationInterface {
  name = 'AddEraPlanToMediaRequest1789900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media_request" ADD "eraPlan" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "eraPlan"`
    );
  }
}
