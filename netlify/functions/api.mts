import type { Config } from "@netlify/functions";
import ExcelJS from "exceljs";
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
const PHOTO_GALLERY_MIME = "application/vnd.bonia.photo-gallery+json";
const MAX_PRODUCT_PHOTOS = 8;

type StoredPhoto = { mimeType: string; data: string };
function storedPhotos(mimeType?: string | null, data?: string | null): StoredPhoto[] {
  if (!mimeType || !data) return [];
  if (mimeType !== PHOTO_GALLERY_MIME) return [{ mimeType, data }];
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.filter((p) => p && ["image/jpeg", "image/png", "image/webp"].includes(p.mimeType) && typeof p.data === "string") : [];
  } catch { return []; }
}

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

function toClient(row: ProductRow, imageUpdatedAt?: Date | null, photos: StoredPhoto[] = []) {
  const version = imageUpdatedAt ? imageUpdatedAt.getTime() : 0;
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
    image: photos.length ? `/api/images/${encodeURIComponent(row.id)}/0?v=${version}` : imageUpdatedAt ? `/api/images/${encodeURIComponent(row.id)}?v=${version}` : "",
    images: photos.map((_, index) => `/api/images/${encodeURIComponent(row.id)}/${index}?v=${version}`),
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
    .select({ product: products, imageUpdatedAt: productImages.updatedAt, imageData: productImages.data, imageMimeType: productImages.mimeType })
    .from(products)
    .leftJoin(productImages, eq(productImages.productId, products.id))
    .orderBy(asc(products.createdAt), asc(products.id));
  const entries = await db.select().from(history).orderBy(desc(history.at), desc(history.id)).limit(HISTORY_LIMIT);
  const [canva] = await db.select().from(settings).where(eq(settings.key, CANVA_KEY));
  const seeding = await db.select().from(kolSeeding).orderBy(desc(kolSeeding.createdAt), desc(kolSeeding.id));
  return Response.json(
    {
      products: rows.map((r) => toClient(r.product, r.imageUpdatedAt, storedPhotos(r.imageMimeType, r.imageData))),
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

// New seeding rows reserve stock while they are out with a KOL. Legacy rows
// stay unmanaged so enabling this feature never changes existing inventory.
async function syncSeedingStock(tx: any, oldRow: SeedingRow | null, nextRow: SeedingRow | null, deleting = false) {
  const oldActive = !!oldRow?.stockManaged && !!oldRow.stockDeducted && oldRow.returnStatus !== "Returned" && !(deleting && oldRow.returnStatus === "Kept by KOL") && !!oldRow.productId && oldRow.quantity > 0;
  const nextActive = !!nextRow?.stockManaged && nextRow.returnStatus !== "Returned" && !!nextRow.productId && nextRow.quantity > 0;
  const ids = [...new Set([oldActive ? oldRow!.productId! : "", nextActive ? nextRow!.productId! : ""].filter(Boolean))].sort();
  const locked = ids.length
    ? await tx.select().from(products).where(sql`${products.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).orderBy(asc(products.id)).for("update")
    : [];
  const productById = new Map<string, ProductRow>(locked.map((p: ProductRow) => [p.id, p]));
  const deltas = new Map<string, { productId: string; size: string; delta: number }>();

  const allocation = (row: SeedingRow, sign: number) => {
    if (!row.productId || row.quantity <= 0) return;
    const product = productById.get(row.productId);
    if (!product) return;
    // Sized products are only deducted once a size has been chosen.
    const size = isSized(product.category) ? row.size : "";
    if (isSized(product.category) && !size) return;
    const key = `${product.id}\u0000${size}`;
    const existing = deltas.get(key) || { productId: product.id, size, delta: 0 };
    existing.delta += sign * row.quantity;
    deltas.set(key, existing);
  };
  if (oldActive) allocation(oldRow!, 1);
  if (nextActive) allocation(nextRow!, -1);

  const entries: (typeof history.$inferSelect)[] = [];
  const stockProducts: { id: string; quantity: number; sizeQuantities: Record<string, number> }[] = [];
  for (const { productId, size, delta } of deltas.values()) {
    if (!delta) continue;
    const before = productById.get(productId)!;
    let patch: Partial<ProductRow>;
    if (size) {
      const sizes = normalizeSizes(before.sizeQuantities);
      const quantity = (sizes[size] || 0) + delta;
      if (quantity < 0) throw new HttpError(409, `Not enough ${size} stock for ${displayName(before)}. Available: ${sizes[size] || 0}`);
      if (quantity) sizes[size] = quantity;
      else delete sizes[size];
      patch = { sizeQuantities: sizes, quantity: sumSizes(sizes), updatedAt: new Date() };
    } else {
      const quantity = before.quantity + delta;
      if (quantity < 0) throw new HttpError(409, `Not enough stock for ${displayName(before)}. Available: ${before.quantity}`);
      patch = { quantity, updatedAt: new Date() };
    }
    const [after] = await tx.update(products).set(patch).where(eq(products.id, productId)).returning();
    productById.set(productId, after);
    stockProducts.push({ id: after.id, quantity: after.quantity, sizeQuantities: normalizeSizes(after.sizeQuantities) });
    const [entry] = await tx.insert(history).values({
      id: uid(), action: delta > 0 ? `Returned from KOL seeding${size ? ` · ${size}` : ""}` : `Sent to KOL${size ? ` · ${size}` : ""}`,
      itemId: productId, name: displayName(after), before: snapshot(before), after: snapshot(after),
    }).returning();
    entries.push(entry);
  }

  const nextProduct = nextActive ? productById.get(nextRow!.productId!) : undefined;
  const row = nextRow ? { ...nextRow, stockDeducted: !!nextProduct && (!isSized(nextProduct.category) || !!nextRow.size) && nextActive } : null;
  return { row, entries: entries.map(historyToClient), stockProducts };
}

async function createSeeding(req: Request) {
  const body = await readJson(req);
  const values: SeedingValues = { dateSent: today() };
  // The product goes last so a size is cleared when the chosen product isn't sized.
  for (const field of [...SEEDING_EDITABLE].filter((f) => f !== "productId").concat("productId")) {
    if (field in body) Object.assign(values, await normalizeSeedingField(field, body[field]));
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(kolSeeding).values({ id: uid(), stockManaged: true, stockDeducted: false, ...values }).returning();
    const { row: allocated, entries: stockEntries, stockProducts } = await syncSeedingStock(tx, null, row);
    if (!allocated) throw new Error("Could not create KOL seeding record");
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Added KOL seeding", itemId: allocated.id, name: seedingName(allocated), before: null, after: seedingSnapshot(allocated) })
      .returning();
    return Response.json({ record: seedingToClient(allocated), entry: historyToClient(entry), entries: [historyToClient(entry), ...stockEntries], stockProducts }, { status: 201 });
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
    let candidate = { ...current, ...values };
    if (field === "productId" && candidate.productId) {
      const [product] = await tx.select().from(products).where(eq(products.id, candidate.productId)).for("update");
      if (!product) throw new HttpError(404, "Product not found");
      candidate = { ...candidate, productName: product.name, productSku: product.sku, ...(!isSized(product.category) ? { size: "" } : {}) };
    }
    const { row: allocated, entries: stockEntries, stockProducts } = await syncSeedingStock(tx, current, candidate);
    const [row] = await tx
      .update(kolSeeding)
      .set({ ...allocated!, updatedAt: new Date() })
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
    return Response.json({ record: seedingToClient(row), entry: entry && historyToClient(entry), entries: [...(entry ? [historyToClient(entry)] : []), ...stockEntries], stockProducts });
  });
}

async function deleteSeeding(id: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(kolSeeding).where(eq(kolSeeding.id, id)).for("update");
    if (!current) throw new HttpError(404, "KOL seeding record not found");
    const { entries: stockEntries, stockProducts } = await syncSeedingStock(tx, current, null, true);
    const [row] = await tx.delete(kolSeeding).where(eq(kolSeeding.id, id)).returning();
    const [entry] = await tx
      .insert(history)
      .values({ id: uid(), action: "Deleted KOL seeding", itemId: id, name: seedingName(row), before: seedingSnapshot(row), after: null })
      .returning();
    return Response.json({ entry: historyToClient(entry), entries: [historyToClient(entry), ...stockEntries], stockProducts });
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
    const [existing] = await tx.select().from(productImages).where(eq(productImages.productId, id));
    // Import uploads only fill in missing photos; they never replace one already in the database.
    if (fromImport && existing) {
      return Response.json({ product: toClient(row, existing.updatedAt, storedPhotos(existing.mimeType, existing.data)), entry: null, skipped: true });
    }
    const now = new Date();
    await tx
      .insert(productImages)
      .values({ productId: id, mimeType: PHOTO_GALLERY_MIME, data: JSON.stringify([{ mimeType, data }]), updatedAt: now })
      .onConflictDoUpdate({ target: productImages.productId, set: { mimeType: PHOTO_GALLERY_MIME, data: JSON.stringify([{ mimeType, data }]), updatedAt: now } });
    let entry = null;
    if (!fromImport) {
      const snap = snapshot(row);
      [entry] = await tx
        .insert(history)
        .values({ id: uid(), action: "Updated product image", itemId: id, name: displayName(row), before: snap, after: snap })
        .returning();
    }
    return Response.json({ product: toClient(row, now, [{ mimeType, data }]), entry: entry && historyToClient(entry) });
  });
}

async function addProductPhoto(req: Request, id: string) {
  const body = await readJson(req);
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image ?? ""));
  if (!match) throw new HttpError(400, "Please upload a JPEG, PNG or WebP image");
  const [, mimeType, data] = match;
  if (data.length * 0.75 > MAX_IMAGE_BYTES) throw new HttpError(413, "Image is too large");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(products).where(eq(products.id, id)).for("update");
    if (!row) throw new HttpError(404, "Product not found");
    const [existing] = await tx.select().from(productImages).where(eq(productImages.productId, id)).for("update");
    if (!existing) throw new HttpError(400, "Add the first product photo before adding more");
    const photos = storedPhotos(existing.mimeType, existing.data);
    if (photos.length >= MAX_PRODUCT_PHOTOS) throw new HttpError(400, `A product can have up to ${MAX_PRODUCT_PHOTOS} photos`);
    photos.push({ mimeType, data });
    const now = new Date();
    await tx.update(productImages).set({ mimeType: PHOTO_GALLERY_MIME, data: JSON.stringify(photos), updatedAt: now }).where(eq(productImages.productId, id));
    const snap = snapshot(row);
    const [entry] = await tx.insert(history).values({ id: uid(), action: "Added product photo", itemId: id, name: displayName(row), before: snap, after: snap }).returning();
    return Response.json({ product: toClient(row, now, photos), entry: historyToClient(entry) });
  });
}

async function getImage(id: string, index = 0) {
  const [img] = await db.select().from(productImages).where(eq(productImages.productId, id));
  if (!img) return new Response("Not found", { status: 404 });
  const photo = storedPhotos(img.mimeType, img.data)[index];
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(photo.data, "base64"), {
    headers: { "content-type": photo.mimeType, "cache-control": "private, max-age=31536000, immutable" },
  });
}

const TRY_ON_ENDPOINT = "fal-ai/image-apps-v2/virtual-try-on";
const MAX_TRY_ON_INPUT_BYTES = 2 * 1024 * 1024;

async function startTryOn(req: Request) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new HttpError(503, "Virtual try-on is not set up yet. Add FAL_KEY in Netlify environment variables.");
  const body = await readJson(req);
  const productId = text(body.productId, 160, "Product ID");
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.personImage ?? ""));
  if (!match) throw new HttpError(400, "Please choose a JPG, PNG or WebP model photo");
  if (match[1].length * 0.75 > MAX_TRY_ON_INPUT_BYTES) throw new HttpError(413, "The model photo is too large. Choose a smaller image.");

  const [row] = await db
    .select({ product: products, imageData: productImages.data, imageMimeType: productImages.mimeType })
    .from(products)
    .leftJoin(productImages, eq(productImages.productId, products.id))
    .where(eq(products.id, productId));
  if (!row) throw new HttpError(404, "Product not found");
  if (!isSized(row.product.category)) throw new HttpError(400, "Virtual try-on is available for Tops and Bottoms only");
  const coverPhoto = storedPhotos(row.imageMimeType, row.imageData)[0];
  if (!coverPhoto) throw new HttpError(400, "Add a product photo before using Virtual Try-On");

  const falResponse = await fetch(`https://queue.fal.run/${TRY_ON_ENDPOINT}`, {
    method: "POST",
    headers: { authorization: `Key ${falKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      person_image_url: `data:image/jpeg;base64,${match[1]}`,
      clothing_image_url: `data:${coverPhoto.mimeType};base64,${coverPhoto.data}`,
      preserve_pose: true,
      aspect_ratio: "3:4",
    }),
  });
  const queued = await falResponse.json().catch(() => ({}));
  if (!falResponse.ok || typeof queued.request_id !== "string") {
    console.error("Virtual try-on request could not be queued", falResponse.status);
    throw new HttpError(502, "The AI service could not start the preview. Please try again later.");
  }
  return Response.json({ requestId: queued.request_id });
}

async function getTryOnStatus(id: string) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new HttpError(503, "Virtual try-on is not set up yet. Add FAL_KEY in Netlify environment variables.");
  if (!/^[a-f0-9-]{20,64}$/i.test(id)) throw new HttpError(400, "Invalid preview request");
  const base = `https://queue.fal.run/${TRY_ON_ENDPOINT}/requests/${encodeURIComponent(id)}`;
  const statusResponse = await fetch(`${base}/status`, { headers: { authorization: `Key ${falKey}` } });
  const status = await statusResponse.json().catch(() => ({}));
  if (!statusResponse.ok) throw new HttpError(502, "Could not check the AI preview status. Please try again.");
  if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS") return Response.json({ status: status.status });
  if (status.status !== "COMPLETED" || status.error) {
    return Response.json({ status: "FAILED", error: "The AI service could not create this preview. Try another photo." });
  }
  const resultResponse = await fetch(base, { headers: { authorization: `Key ${falKey}` } });
  const result = await resultResponse.json().catch(() => ({}));
  const imageUrl = result.images?.[0]?.url;
  if (!resultResponse.ok || typeof imageUrl !== "string") {
    throw new HttpError(502, "The AI preview finished but its image could not be retrieved.");
  }
  const parsedUrl = new URL(imageUrl);
  if (parsedUrl.protocol !== "https:" || !(parsedUrl.hostname === "fal.media" || parsedUrl.hostname.endsWith(".fal.media"))) {
    throw new HttpError(502, "The AI service returned an unsupported image link.");
  }
  return Response.json({ status: "COMPLETED", imageUrl }, { headers: { "cache-control": "no-store" } });
}

async function exportWorkbook(req: Request) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Inventory Stocks";
  workbook.created = new Date();

  const inventory = workbook.addWorksheet("Inventory");
  inventory.columns = [
    { header: "Product photo", key: "photo", width: 18 },
    { header: "Photo status", key: "photoStatus", width: 18 },
    { header: "Name", key: "name", width: 28 },
    { header: "Price (RM)", key: "price", width: 14 },
    { header: "SKU", key: "sku", width: 18 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Date", key: "date", width: 14 },
    { header: "Gender", key: "gender", width: 14 },
    { header: "Category", key: "category", width: 22 },
    { header: "Size", key: "size", width: 12 },
    { header: "Qty S", key: "qtyS", width: 10 },
    { header: "Qty M", key: "qtyM", width: 10 },
    { header: "Qty L", key: "qtyL", width: 10 },
    { header: "Qty XL", key: "qtyXL", width: 10 },
    { header: "Description", key: "description", width: 42 },
    { header: "Created at", key: "createdAt", width: 24 },
    { header: "Updated at", key: "updatedAt", width: 24 },
  ];
  inventory.views = [{ state: "frozen", ySplit: 1 }];
  inventory.autoFilter = "A1:Q1";

  const productRows = await db
    .select({ product: products, imageData: productImages.data, imageMimeType: productImages.mimeType })
    .from(products)
    .leftJoin(productImages, eq(productImages.productId, products.id))
    .orderBy(asc(products.createdAt), asc(products.id));

  for (const { product, imageData, imageMimeType } of productRows) {
    const sizes = normalizeSizes(product.sizeQuantities);
    const row = inventory.addRow({
      photo: "",
      photoStatus: "Photo missing",
      name: product.name,
      price: product.price == null ? "" : Number(product.price),
      sku: product.sku,
      quantity: product.quantity,
      date: product.date ?? "",
      gender: product.gender,
      category: product.category,
      size: product.size,
      qtyS: sizes.S ?? 0,
      qtyM: sizes.M ?? 0,
      qtyL: sizes.L ?? 0,
      qtyXL: sizes.XL ?? 0,
      description: product.description,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    });
    row.height = 64;
    const coverPhoto = storedPhotos(imageMimeType, imageData)[0];
    if (!coverPhoto) continue;
    const extension = coverPhoto.mimeType === "image/jpeg" ? "jpeg" : coverPhoto.mimeType === "image/png" ? "png" : null;
    if (!extension) {
      row.getCell("photoStatus").value = `Photo missing (unsupported ${coverPhoto.mimeType})`;
      continue;
    }
    try {
      const imageId = workbook.addImage({ base64: `data:${coverPhoto.mimeType};base64,${coverPhoto.data}`, extension });
      const rowNumber = row.number;
      inventory.addImage(imageId, {
        tl: { col: 0.08, row: rowNumber - 0.92 },
        ext: { width: 108, height: 68 },
        editAs: "oneCell",
      });
      row.getCell("photoStatus").value = "Embedded";
    } catch {
      row.getCell("photoStatus").value = "Photo missing (could not embed)";
    }
  }

  const seeding = workbook.addWorksheet("KOL Seeding");
  seeding.columns = [
    { header: "Record ID", key: "id", width: 24 },
    { header: "KOL / Creator", key: "kolName", width: 26 },
    { header: "Product", key: "productName", width: 30 },
    { header: "SKU", key: "productSku", width: 18 },
    { header: "Size", key: "size", width: 12 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Date sent", key: "dateSent", width: 14 },
    { header: "Status", key: "returnStatus", width: 18 },
    { header: "Return date", key: "returnDate", width: 14 },
    { header: "Notes", key: "notes", width: 42 },
    { header: "Created at", key: "createdAt", width: 24 },
    { header: "Updated at", key: "updatedAt", width: 24 },
  ];
  seeding.views = [{ state: "frozen", ySplit: 1 }];
  seeding.autoFilter = "A1:L1";
  const seedingRows = await db.select().from(kolSeeding).orderBy(desc(kolSeeding.createdAt), desc(kolSeeding.id));
  for (const record of seedingRows) {
    seeding.addRow({
      id: record.id,
      kolName: record.kolName,
      productName: record.productName,
      productSku: record.productSku,
      size: record.size,
      quantity: record.quantity,
      dateSent: record.dateSent ?? "",
      returnStatus: record.returnStatus,
      returnDate: record.returnDate ?? "",
      notes: record.notes,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  for (const sheet of [inventory, seeding]) {
    const header = sheet.getRow(1);
    header.height = 28;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FF3D392B" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF0B8" } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell) => { cell.alignment = { vertical: "middle", wrapText: true }; });
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="inventory-stocks.xlsx"',
      "cache-control": "no-store",
    },
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
    if (resource === "export.xlsx" && !id && method === "GET") return await exportWorkbook(req);
    if (resource === "try-on" && !id && method === "POST") return await startTryOn(req);
    if (resource === "try-on" && id && !sub && method === "GET") return await getTryOnStatus(id);
    if (resource === "import" && !id && method === "POST") return await importLocal(req);
    if (resource === "images" && id && method === "GET") return await getImage(id, sub ? Math.max(0, Number.parseInt(sub, 10) || 0) : 0);
    if (resource === "products") {
      if (!id && method === "POST") return await createProduct(req);
      if (id && !sub && method === "PATCH") return await updateProduct(req, id);
      if (id && !sub && method === "DELETE") return await deleteProduct(id);
      if (id && sub === "image" && method === "PUT") return await putImage(req, id);
      if (id && sub === "photos" && method === "POST") return await addProductPhoto(req, id);
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
  path: ["/api/state", "/api/export.xlsx", "/api/try-on", "/api/try-on/:id", "/api/import", "/api/images/:id", "/api/images/:id/:index", "/api/products", "/api/products/:id", "/api/products/:id/image", "/api/products/:id/photos", "/api/seeding", "/api/seeding/:id", "/api/settings/:key"],
};
