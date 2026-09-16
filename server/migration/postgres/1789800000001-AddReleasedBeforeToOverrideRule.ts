import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleasedBeforeToOverrideRule1789800000001 implements MigrationInterface {
  name = 'AddReleasedBeforeToOverrideRule1789800000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "releasedBefore" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "releasedBefore"`
    );
  }
}
