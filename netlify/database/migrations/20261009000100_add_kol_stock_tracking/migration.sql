ALTER TABLE "kol_seeding"
  ADD COLUMN "stock_managed" boolean NOT NULL DEFAULT false,
  ADD COLUMN "stock_deducted" boolean NOT NULL DEFAULT false;
