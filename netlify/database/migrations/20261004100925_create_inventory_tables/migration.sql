CREATE TABLE "history" (
	"id" text PRIMARY KEY,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"item_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"product_id" text PRIMARY KEY,
	"mime_type" text NOT NULL,
	"data" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY,
	"name" text DEFAULT '' NOT NULL,
	"price" numeric(12,2),
	"sku" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"date" date,
	"gender" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "history_at_idx" ON "history" ("at");--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;