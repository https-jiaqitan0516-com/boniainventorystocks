import type { Config } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { history, kolSeeding, productImages, products, settings } from "../../db/schema.js";
import { isAuthenticated, isConfigured, notConfigured } from "../lib/auth.mjs";

const GENDERS = ["Men", "Women", "Unisex"];
// Older data (e.g. a browser import) may still use the previous group name.
const LEGACY_GENDERS: Record<string, string> = { Male: "Men" };
const CATEGORIES = ["Bags", "Tops", "Bottoms", "Accessories"];
// Categories whose stock is tracked per size.
const SIZED_CATEGORIES = ["Tops", "Bottoms"];
// Older data (e.g. a browser import) may still use the previous category names.
const LEGACY_CATEGORIES: Record<string, string> = { Styling: "Tops", "Small Leather Goods": "Accessories" };
const RETURN_STATUSES = ["Not returned", "Returned", "Kept by KOL"];
const SEEDING_KEYS = ["kolName", "product", "size", "quantity", "dateSent", "returnStatus", "returnDate", "notes"] as const;
const SEEDING_EDITABLE = new Set<string>(["kolName", "productId", "size", "quantity", "dateSent", "returnStatus", "returnDate", "notes"]);
const SEEDING_LABELS: Record<string, string> = {
  kolName: "KOL name",
  productId: "product",
  size: "size",
  quantity: "quantity sent",
  dateSent: "date sent",
  returnStatus: "return status",
  returnDate: "return date",
  notes: "notes",
};
const SIZES = ["S", "M", "L", "XL"];
const SNAPSHOT_KEYS = ["name", "price", "sku", "quantity", "date", "gender", "category", "size", "description"] as const;
const EDITABLE = new Set<string>([...SNAPSHOT_KEYS, "sizeQuantity"]);
const MAX_SIZE_QUANTITY = 100_000_000;
const HISTORY_LIMIT = 500;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

type ProductRow = typeof products.$inferSelect;
type SeedingRow = typeof kolSeeding.$inferSelect;
type SeedingValues = Partial<Omit<typeof kolSeeding.$inferInsert, "id" | "createdAt" | "updatedAt">>;
type ProductValues = Partial<Omit<typeof products.$inferInsert, "id" | "createdAt" | "updatedAt">>;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function uid() {
  return Date.now().toString(36) + randomBytes(4).toString("hex");
}

function text(value: unknown, max: number, field: string): string {
  const s = String(value ?? "");
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  return s;
}

function isSized(category: string | null | undefined) {
  return SIZED_CATEGORIES.includes(category ?? "");
}

function dateValue(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, "Invalid date");
  return s;
}

// Today's date in Malaysia, as YYYY-MM-DD.
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
}

function oneOf(value: unknown, allowed: string[], field: string): string {
  const s = String(value ?? "");
  if (s && !allowed.includes(s)) throw new HttpError(400, `Invalid ${field}`);
  return s;
}

// Converts a single editable field from the UI into its database value.
function normalizeField(field: string, value: unknown): ProductValues {
  switch (field) {
    case "name":
      return { name: text(value, 300, "Name") };
    case "sku":
      return { sku: text(value, 120, "SKU") };
    case "description":
      return { description: text(value, 5000, "Description") };
    case "price": {
      const s = String(value ?? "").trim();
      if (!s) return { price: null };
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0 || n >= 1e10) throw new HttpError(400, "Invalid price");
      return { price: n.toFixed(2) };
    }
    case "quantity": {
      const s = String(value ?? "").trim();
      if (!s) return { quantity: 0 };
      const n = Number(s);
      if (!Number.isInteger(n) || Math.abs(n) > 2_000_000_000) throw new HttpError(400, "Quantity must be a whole number");
      return { quantity: n };
    }
    case "date":
      return { date: dateValue(value) };
    case "gender":
      return { gender: oneOf(LEGACY_GENDERS[String(value ?? "")] ?? value, GENDERS, "gender") };
    case "category":
      return { category: oneOf(LEGACY_CATEGORIES[String(value ?? "")] ?? value, CATEGORIES, "category") };
    case "size":
      return { size: oneOf(value, SIZES, "size") };
  }
  throw new HttpError(400, "Unknown field");
}

function sizeQuantity(value: unknown): number {
  const s = String(value ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SIZE_QUANTITY) throw new HttpError(400, "Size quantity must be a whole number of 0 or more");
  return n;
}

// Keeps only known sizes with stock, so {} means "no size quantities recorded".
function normalizeSizes(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const size of SIZES) {
    const n = sizeQuantity((value as Record<string, unknown>)[size]);
    if (n > 0) out[size] = n;
  }
  return out;
}

function sumSizes(sizes: Record<string, number>) {
  return Object.values(sizes).reduce((a, b) => a + b, 0);
}

function hasSizes(sizes: Record<string, number>) {
  return Object.keys(sizes).length > 0;
}

// "L: 1, XL: 1" — used in history snapshots so per-size changes are recorded.
function sizesText(sizes: Record<string, number>) {
  return SIZES.filter((s) => sizes[s] > 0).map((s) => `${s}: ${sizes[s]}`).join(", ");
}

function normalizeProduct(input: Record<string, unknown>): ProductValues {
  const out: ProductValues = {};
  for (const key of SNAPSHOT_KEYS) {
    if (key in input) Object.assign(out, normalizeField(key, input[key]));
  }
  if (isSized(out.category)) {
    let sizes = normalizeSizes(input.sizeQuantities);
    if (!hasSizes(sizes) && out.size && (out.quantity ?? 0) > 0) sizes = { [out.size]: out.quantity! };
    if (hasSizes(sizes)) Object.assign(out, { sizeQuantities: sizes, quantity: sumSizes(sizes) });
  }
  return out;
}

function toClient(row: ProductRow, imageUpdatedAt?: Date | null) {
  return {
    id: row.id,
    name: row.name,
    price: row.price ?? "",
    sku: row.sku,
    quantity: row.quantity,
    date: row.date ?? "",
    gender: row.gender,
    category: row.category,
    size: row.size,
    sizeQuantities: normalizeSizes(row.sizeQuantities),
    description: row.description,
    image: imageUpdatedAt ? `/api/images/${encodeURIComponent(row.id)}?v=${imageUpdatedAt.getTime()}` : "",
  };
}

function snapshot(row: ProductRow) {
  const c = toClient(row);
  const out: Record<string, string> = {};
  for (const key of SNAPSHOT_KEYS) out[key] = String(c[key] ?? "");
  out.sizes = isSized(row.category) ? sizesText(c.sizeQuantities) : "";
  return out;
}

function historyToClient(h: typeof history.$inferSelect) {
  return { id: h.id, at: h.at.toISOString(), action: h.action, itemId: h.itemId, name: h.name, before: h.before, after: h.after };
}

function displayName(row: ProductRow) {
  return row.name || row.sku || "Untitled product";
}

async function readJson(req: Request): Promise<Record<string, any>> {
  if (!(req.headers.get("content-type") || "").includes("application/json")) {
    throw new HttpError(415, "Expected JSON");
  }
  try {
    const body = await req.json();
    if (body && typeof body === "object") return body;
  } catch {}
  throw new HttpError(400, "Invalid JSON body");
}

async function getState() {
  const rows = await db
    .select({ product: products, imageUpdatedAt: productImages.updatedAt })
    .from(products)
    .leftJoin(productImages, eq(productImages.productId, products.id))
    .orderBy(asc(products.createdAt), asc(products.id));
  const entries = await db.select().from(history).orderBy(desc(history.at), desc(history.id)).limit(HISTORY_LIMIT);
  const [canva] = await db.select().from(settings).where(eq(settings.key, CANVA_KEY));
  const seeding = await db.select().from(kolSeeding).orderBy(desc(kolSeeding.createdAt), desc(kolSeeding.id));
  return Response.json(
    {
      products: rows.map((r) => toClient(r.product, r.imageUpdatedAt)),
      history: entries.map(historyToClient),
      seeding: seeding.map(seedingToClient),
      canvaUrl: canva?.value ?? "",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// ---- Shared Canva link (shown under the page heading) ----

const CANVA_KEY = "canva_url";

function canvaUrlValue(value: unknown): string {
  const s = text(value, 2000, "Canva link").trim();
  if (!s) return "";
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    throw new HttpError(400, "Please enter a valid link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Please enter a valid link");
  return url.toString();
}

async function putCanvaUrl(req: Request) {
  const body = await readJson(req);
  const value = canvaUrlValue(body.value);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(settings).where(eq(settings.key, CANVA_KEY)).for("update");
    const before = current?.value ?? "";
    if (before === value) return Response.json({ canvaUrl: value, entry: null });
    const now = new Date();
    await tx
      .insert(settings)
      .values({ key: CANVA_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Updated Canva link", itemId: "", name: "Canva link", before: { canvaUrl: before }, after: { canvaUrl: value } })
      .returning();
    return Response.json({ canvaUrl: value, entry: historyToClient(entry) });
  });
}

// ---- KOL Seeding ----

function seedingToClient(row: SeedingRow) {
  return {
    id: row.id,
    kolName: row.kolName,
    productId: row.productId ?? "",
    productName: row.productName,
    productSku: row.productSku,
    size: row.size,
    quantity: row.quantity,
    dateSent: row.dateSent ?? "",
    returnStatus: row.returnStatus,
    returnDate: row.returnDate ?? "",
    notes: row.notes,
  };
}

function seedingSnapshot(row: SeedingRow) {
  const c = seedingToClient(row);
  const out: Record<string, string> = {};
  for (const key of SEEDING_KEYS) {
    out[key] = key === "product" ? [c.productName, c.productSku && `(${c.productSku})`].filter(Boolean).join(" ") : String(c[key] ?? "");
  }
  return out;
}

function seedingName(row: SeedingRow) {
  return `KOL Seeding: ${row.kolName || "Unnamed KOL"} · ${row.productName || "No product"}`;
}

// Converts a single editable seeding field into its database values.
async function normalizeSeedingField(field: string, value: unknown): Promise<SeedingValues> {
  switch (field) {
    case "kolName":
      return { kolName: text(value, 200, "KOL name").trim() };
    case "notes":
      return { notes: text(value, 5000, "Notes") };
    case "size":
      return { size: oneOf(value, SIZES, "size") };
    case "quantity": {
      const s = String(value ?? "").trim();
      const n = Number(s || "0");
      if (!Number.isInteger(n) || n < 0 || n > MAX_SIZE_QUANTITY) throw new HttpError(400, "Quantity sent must be a whole number of 0 or more");
      return { quantity: n };
    }
    case "dateSent":
      return { dateSent: dateValue(value) };
    case "returnDate":
      return { returnDate: dateValue(value) };
    case "returnStatus":
      return { returnStatus: oneOf(value, RETURN_STATUSES, "return status") || "Not returned" };
    case "productId": {
      const id = String(value ?? "");
      if (!id) return { productId: null, productName: "", productSku: "" };
      const [p] = await db.select().from(products).where(eq(products.id, id));
      if (!p) throw new HttpError(404, "Product not found");
      return { productId: p.id, productName: p.name, productSku: p.sku, ...(isSized(p.category) ? {} : { size: "" }) };
    }
  }
  throw new HttpError(400, "Unknown field");
}

async function createSeeding(req: Request) {
  const body = await readJson(req);
  const values: SeedingValues = { dateSent: today() };
  // The product goes last so a size is cleared when the chosen product isn't sized.
  for (const field of [...SEEDING_EDITABLE].filter((f) => f !== "productId").concat("productId")) {
    if (field in body) Object.assign(values, await normalizeSeedingField(field, body[field]));
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(kolSeeding).values({ id: uid(), ...values }).returning();
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Added KOL seeding", itemId: row.id, name: seedingName(row), before: null, after: seedingSnapshot(row) })
      .returning();
    return Response.json({ record: seedingToClient(row), entry: historyToClient(entry) }, { status: 201 });
  });
}

async function updateSeeding(req: Request, id: string) {
  const body = await readJson(req);
  const field = String(body.field ?? "");
  if (!SEEDING_EDITABLE.has(field)) throw new HttpError(400, "Unknown field");
  const values = await normalizeSeedingField(field, body.value);

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(kolSeeding).where(eq(kolSeeding.id, id)).for("update");
    if (!current) throw new HttpError(404, "KOL seeding record not found");
    // Marking an item as returned fills in today's date if no return date was entered yet.
    if (field === "returnStatus" && values.returnStatus === "Returned" && !current.returnDate) values.returnDate = today();
    const [row] = await tx
      .update(kolSeeding)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(kolSeeding.id, id))
      .returning();
    const before = seedingSnapshot(current);
    const after = seedingSnapshot(row);
    let entry = null;
    if (SEEDING_KEYS.some((k) => before[k] !== after[k])) {
      [entry] = await tx
        .insert(history)
        .values({ id: uid(), action: `Updated KOL seeding ${SEEDING_LABELS[field]}`, itemId: id, name: seedingName(row), before, after })
        .returning();
    }
    return Response.json({ record: seedingToClient(row), entry: entry && historyToClient(entry) });
  });
}

async function deleteSeeding(id: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(kolSeeding).where(eq(kolSeeding.id, id)).returning();
    if (!row) throw new HttpError(404, "KOL seeding record not found");
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Deleted KOL seeding", itemId: id, name: seedingName(row), before: seedingSnapshot(row), after: null })
      .returning();
    return Response.json({ entry: historyToClient(entry) });
  });
}

async function createProduct(req: Request) {
  const body = await readJson(req);
  const values = normalizeProduct({
    gender: body.gender,
    category: body.category,
    date: body.date,
  });
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(products).values({ id: uid(), ...values }).returning();
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Added product", itemId: row.id, name: displayName(row), before: null, after: snapshot(row) })
      .returning();
    return Response.json({ product: toClient(row), entry: historyToClient(entry) }, { status: 201 });
  });
}

async function updateProduct(req: Request, id: string) {
  const body = await readJson(req);
  const field = String(body.field ?? "");
  if (!EDITABLE.has(field)) throw new HttpError(400, "Unknown field");
  const values = field === "sizeQuantity" ? {} : normalizeField(field, body.value);

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(products).where(eq(products.id, id)).for("update");
    if (!current) throw new HttpError(404, "Product not found");
    const currentSizes = normalizeSizes(current.sizeQuantities);
    const sized = isSized(values.category ?? current.category);
    let action = `Updated ${field}`;
    let compareKey = field;
    if (field === "sizeQuantity") {
      // Merge one size into the stored map under the row lock, so people editing different sizes don't overwrite each other.
      if (!isSized(current.category)) throw new HttpError(400, "Only Tops and Bottoms have size quantities");
      const size = oneOf(body.size, SIZES, "size");
      if (!size) throw new HttpError(400, "Invalid size");
      const sizes = { ...currentSizes };
      const n = sizeQuantity(body.value);
      if (n > 0) sizes[size] = n;
      else delete sizes[size];
      Object.assign(values, { sizeQuantities: sizes, quantity: hasSizes(sizes) || hasSizes(currentSizes) ? sumSizes(sizes) : current.quantity });
      action = `Updated size ${size} quantity`;
      compareKey = "sizes";
    } else if (field === "quantity" && sized && hasSizes(currentSizes)) {
      throw new HttpError(400, "The quantity of Tops and Bottoms is calculated from their sizes");
    } else if (field === "category" && isSized(values.category) && !isSized(current.category) && hasSizes(currentSizes)) {
      values.quantity = sumSizes(currentSizes);
    }
    const [row] = await tx
      .update(products)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    const before = snapshot(current);
    const after = snapshot(row);
    let entry = null;
    if (before[compareKey] !== after[compareKey]) {
      [entry] = await tx
        .insert(history)
        .values({ id: uid(), action, itemId: id, name: displayName(row), before, after })
        .returning();
    }
    const [img] = await tx.select({ updatedAt: productImages.updatedAt }).from(productImages).where(eq(productImages.productId, id));
    return Response.json({ product: toClient(row, img?.updatedAt), entry: entry && historyToClient(entry) });
  });
}

async function deleteProduct(id: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(products).where(eq(products.id, id)).returning();
    if (!row) throw new HttpError(404, "Product not found");
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Deleted product", itemId: id, name: displayName(row), before: snapshot(row), after: null })
      .returning();
    return Response.json({ entry: historyToClient(entry) });
  });
}

async function putImage(req: Request, id: string) {
  const body = await readJson(req);
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image ?? ""));
  if (!match) throw new HttpError(400, "Please upload a JPEG, PNG or WebP image");
  const [, mimeType, data] = match;
  if (data.length * 0.75 > MAX_IMAGE_BYTES) throw new HttpError(413, "Image is too large");
  const fromImport = body.source === "import";

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(products).where(eq(products.id, id)).for("update");
    if (!row) throw new HttpError(404, "Product not found");
    const [existing] = await tx.select({ updatedAt: productImages.updatedAt }).from(productImages).where(eq(productImages.productId, id));
    // Import uploads only fill in missing photos; they never replace one already in the database.
    if (fromImport && existing) {
      return Response.json({ product: toClient(row, existing.updatedAt), entry: null, skipped: true });
    }
    const now = new Date();
    await tx
      .insert(productImages)
      .values({ productId: id, mimeType, data, updatedAt: now })
      .onConflictDoUpdate({ target: productImages.productId, set: { mimeType, data, updatedAt: now } });
    let entry = null;
    if (!fromImport) {
      const snap = snapshot(row);
      [entry] = await tx
        .insert(history)
        .values({ id: uid(), action: "Updated product image", itemId: id, name: displayName(row), before: snap, after: snap })
        .returning();
    }
    return Response.json({ product: toClient(row, now), entry: entry && historyToClient(entry) });
  });
}

async function getImage(id: string) {
  const [img] = await db.select().from(productImages).where(eq(productImages.productId, id));
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(img.data, "base64"), {
    headers: { "content-type": img.mimeType, "cache-control": "private, max-age=31536000, immutable" },
  });
}

// One-time import of inventory saved in a browser. Only runs when the database has
// no products and no history, and never overwrites an existing row.
async function importLocal(req: Request) {
  const body = await readJson(req);
  const incoming = Array.isArray(body.products) ? body.products : [];
  const incomingHistory = Array.isArray(body.history) ? body.history : [];
  if (!incoming.length) throw new HttpError(400, "Nothing to import");
  if (incoming.length > 5000 || incomingHistory.length > 1000) throw new HttpError(413, "Too many records to import at once");

  const base = Date.now() - incoming.length;
  const seen = new Set<string>();
  const rows = incoming.map((p: Record<string, unknown>, i: number) => {
    let id = typeof p?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.id) ? p.id : uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    let values: ProductValues;
    try {
      values = normalizeProduct(p ?? {});
    } catch (e) {
      throw new HttpError(400, `Product ${i + 1}: ${(e as Error).message}`);
    }
    // Keep the browser's original order.
    return { id, ...values, createdAt: new Date(base + i), updatedAt: new Date() };
  });

  const historyRows = incomingHistory
    .filter((h: any) => h && typeof h === "object" && !Number.isNaN(Date.parse(h.at)))
    .map((h: any) => ({
      id: typeof h.id === "string" && h.id.length <= 64 ? h.id : uid(),
      at: new Date(h.at),
      action: text(h.action, 200, "History action"),
      itemId: text(h.itemId, 64, "History item"),
      name: text(h.name, 300, "History name"),
      before: h.before && typeof h.before === "object" ? h.before : null,
      after: h.after && typeof h.after === "object" ? h.after : null,
    }));

  return db.transaction(async (tx) => {
    // Block concurrent imports/edits while checking that the database is empty.
    await tx.execute(sql`LOCK TABLE products, history IN SHARE ROW EXCLUSIVE MODE`);
    const [{ count: productCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(products);
    const [{ count: historyCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(history);
    if (productCount > 0 || historyCount > 0) {
      throw new HttpError(409, "The shared database already has inventory, so nothing was imported.");
    }
    let imported = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await tx.insert(products).values(rows.slice(i, i + 500)).onConflictDoNothing().returning({ id: products.id });
      imported += res.length;
    }
    for (let i = 0; i < historyRows.length; i += 500) {
      await tx.insert(history).values(historyRows.slice(i, i + 500)).onConflictDoNothing();
    }
    await tx.insert(history).values({
      id: uid(),
      action: `Imported ${imported} ${imported === 1 ? "product" : "products"} from browser`,
      itemId: "",
      name: "Inventory import",
      before: null,
      after: null,
    });
    return Response.json({ imported, ids: rows.map((r: { id: string }) => r.id) });
  });
}

export default async (req: Request) => {
  if (!isConfigured()) return notConfigured();
  if (!isAuthenticated(req)) return Response.json({ error: "Please log in" }, { status: 401 });

  const parts = new URL(req.url).pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  const [resource, id, sub] = parts;
  const method = req.method;

  try {
    if (resource === "state" && !id && method === "GET") return await getState();
    if (resource === "import" && !id && method === "POST") return await importLocal(req);
    if (resource === "images" && id && !sub && method === "GET") return await getImage(id);
    if (resource === "products") {
      if (!id && method === "POST") return await createProduct(req);
      if (id && !sub && method === "PATCH") return await updateProduct(req, id);
      if (id && !sub && method === "DELETE") return await deleteProduct(id);
      if (id && sub === "image" && method === "PUT") return await putImage(req, id);
    }
    if (resource === "settings" && id === "canva" && !sub && method === "PUT") return await putCanvaUrl(req);
    if (resource === "seeding") {
      if (!id && method === "POST") return await createSeeding(req);
      if (id && !sub && method === "PATCH") return await updateSeeding(req, id);
      if (id && !sub && method === "DELETE") return await deleteSeeding(id);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
    console.error(e);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
};

export const config: Config = {
  path: ["/api/state", "/api/import", "/api/images/:id", "/api/products", "/api/products/:id", "/api/products/:id/image", "/api/seeding", "/api/seeding/:id", "/api/settings/:key"],
};
