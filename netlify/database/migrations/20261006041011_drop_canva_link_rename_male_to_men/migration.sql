ALTER TABLE "products" DROP COLUMN "canva_url";--> statement-breakpoint
-- The "Male" group is renamed "Men".
UPDATE "products" SET "gender" = 'Men' WHERE "gender" = 'Male';
