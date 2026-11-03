import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScannedFile1790200000000 implements MigrationInterface {
  name = 'AddScannedFile1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "scanned_file" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "path" varchar NOT NULL, "fingerprint" varchar NOT NULL, "damaged" boolean NOT NULL DEFAULT (0), "zeroPercent" integer NOT NULL DEFAULT (0), "firstSeenAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_scanned_file_path" UNIQUE ("path"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scanned_file_damaged" ON "scanned_file" ("damaged") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_scanned_file_damaged"`);
    await queryRunner.query(`DROP TABLE "scanned_file"`);
  }
}
