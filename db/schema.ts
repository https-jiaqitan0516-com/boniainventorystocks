import { pgTable, text, integer, numeric, date, timestamp, jsonb, index, boolean } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: text().primaryKey(),
  name: text().notNull().default(""),
  price: numeric({ precision: 12, scale: 2 }),
  sku: text().notNull().default(""),
  quantity: integer().notNull().default(0),
  date: date({ mode: "string" }),
  gender: text().notNull().default(""),
  category: text().notNull().default(""),
  size: text().notNull().default(""),
  // Tops and Bottoms track stock per size, e.g. { "L": 1, "XL": 1 }; quantity is their sum.
  sizeQuantities: jsonb("size_quantities").$type<Record<string, number>>().notNull().default({}),
  description: text().notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Product photos live in their own table so list queries stay small, and so each
// deploy preview's database branch carries its own copy of the images.
export const productImages = pgTable("product_images", {
  productId: text("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  mimeType: text("mime_type").notNull(),
  data: text().notNull(), // base64
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const history = pgTable(
  "history",
  {
    id: text().primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    action: text().notNull(),
    itemId: text("item_id").notNull(),
    name: text().notNull().default(""),
    before: jsonb(),
    after: jsonb(),
  },
  (t) => [index("history_at_idx").on(t.at)],
);

// Products sent to KOLs/creators. Product name/SKU are copied at send time so the record
// still reads correctly if the product is renamed or deleted later.
export const kolSeeding = pgTable(
  "kol_seeding",
  {
    id: text().primaryKey(),
    kolName: text("kol_name").notNull().default(""),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    productName: text("product_name").notNull().default(""),
    productSku: text("product_sku").notNull().default(""),
    size: text().notNull().default(""),
    quantity: integer().notNull().default(1),
    dateSent: date("date_sent", { mode: "string" }),
    returnStatus: text("return_status").notNull().default("Not returned"),
    returnDate: date("return_date", { mode: "string" }),
    notes: text().notNull().default(""),
    // Only records created after stock tracking is enabled affect inventory.
    // Existing seeding rows remain untouched when the migration is applied.
    stockManaged: boolean("stock_managed").notNull().default(false),
    stockDeducted: boolean("stock_deducted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("kol_seeding_date_sent_idx").on(t.dateSent)],
);

// Shared app-wide settings, e.g. the Canva link shown under the page heading.
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
