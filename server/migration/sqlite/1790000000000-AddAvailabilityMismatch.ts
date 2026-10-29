import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAvailabilityMismatch1790000000000 implements MigrationInterface {
  name = 'AddAvailabilityMismatch1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "availability_mismatch" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaId" integer NOT NULL, "seasonNumber" integer NOT NULL, "title" varchar, "plexEpisodes" integer NOT NULL DEFAULT (0), "sonarrEpisodes" integer NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('open'), "firstSeenAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "resolvedAt" datetime, "resolvedById" integer, CONSTRAINT "UQ_63c42919ce4d5d1f0c6b4f75700" UNIQUE ("mediaId", "seasonNumber"), CONSTRAINT "FK_b4aa6f81205e9251faf063d5353" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_76d6f7de1306fef0a10fc280475" FOREIGN KEY ("resolvedById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4490288abfb7bc8ada4da35735" ON "availability_mismatch" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_76d6f7de1306fef0a10fc28047" ON "availability_mismatch" ("resolvedById") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_76d6f7de1306fef0a10fc28047"`);
    await queryRunner.query(`DROP INDEX "IDX_4490288abfb7bc8ada4da35735"`);
    await queryRunner.query(`DROP TABLE "availability_mismatch"`);
  }
}
