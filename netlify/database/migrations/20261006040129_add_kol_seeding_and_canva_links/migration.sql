CREATE TABLE "kol_seeding" (
	"id" text PRIMARY KEY,
	"kol_name" text DEFAULT '' NOT NULL,
	"product_id" text,
	"product_name" text DEFAULT '' NOT NULL,
	"product_sku" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"date_sent" date,
	"return_status" text DEFAULT 'Not returned' NOT NULL,
	"return_date" date,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "canva_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "kol_seeding_date_sent_idx" ON "kol_seeding" ("date_sent");--> statement-breakpoint
ALTER TABLE "kol_seeding" ADD CONSTRAINT "kol_seeding_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Styling is replaced by Tops (existing Styling products move to Tops); Small Leather Goods is renamed Accessories.
UPDATE "products" SET "category" = 'Tops' WHERE "category" = 'Styling';--> statement-breakpoint
UPDATE "products" SET "category" = 'Accessories' WHERE "category" = 'Small Leather Goods';
