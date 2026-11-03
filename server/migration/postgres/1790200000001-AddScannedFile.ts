import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScannedFile1790200000001 implements MigrationInterface {
  name = 'AddScannedFile1790200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "scanned_file" ("id" SERIAL NOT NULL, "path" character varying NOT NULL, "fingerprint" character varying NOT NULL, "damaged" boolean NOT NULL DEFAULT false, "zeroPercent" integer NOT NULL DEFAULT '0', "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "UQ_scanned_file_path" UNIQUE ("path"), CONSTRAINT "PK_scanned_file" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scanned_file_damaged" ON "scanned_file" ("damaged") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_scanned_file_damaged"`);
    await queryRunner.query(`DROP TABLE "scanned_file"`);
  }
}
