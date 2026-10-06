ALTER TABLE "products" ADD COLUMN "size_quantities" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Existing Styling products had one size and one quantity; carry that over as their first size entry.
UPDATE "products" SET "size_quantities" = jsonb_build_object("size", "quantity") WHERE "category" = 'Styling' AND "size" IN ('S', 'M', 'L', 'XL') AND "quantity" > 0;
