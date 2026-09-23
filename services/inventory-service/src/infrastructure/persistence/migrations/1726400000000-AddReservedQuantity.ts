import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReservedQuantity1726400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stock_item" ADD COLUMN "reserved_quantity" integer NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {}
}

// touched to re-trigger the live publish check
