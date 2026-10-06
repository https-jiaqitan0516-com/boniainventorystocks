CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
