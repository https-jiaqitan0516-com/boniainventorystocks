import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "inv_session";
const SESSION_DAYS = 30;

function sharedPassword(): string | undefined {
  const value = Netlify.env.get("INVENTORY_SHARED_PASSWORD");
  return value && value.length > 0 ? value : undefined;
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so both buffers have equal length and comparison time doesn't leak length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// The signing key is derived from the password, so changing the password signs everyone out.
function sign(password: string, expires: number): string {
  return createHmac("sha256", password).update(`inventory-session:${expires}`).digest("base64url");
}

// Returns every value for the cookie: an older unpartitioned session cookie can coexist with a partitioned one.
function readCookies(req: Request, name: string): string[] {
  const header = req.headers.get("cookie") || "";
  const out: string[] = [];
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) out.push(v.join("="));
  }
  return out;
}

function validToken(token: string, password: string): boolean {
  const [expRaw, sig] = token.split(".");
  const expires = Number(expRaw);
  if (!Number.isFinite(expires) || expires < Date.now() || !sig) return false;
  return safeEqual(sig, sign(password, expires));
}

export function isConfigured(): boolean {
  return sharedPassword() !== undefined;
}

export function checkPassword(candidate: unknown): boolean {
  const password = sharedPassword();
  if (!password || typeof candidate !== "string") return false;
  return safeEqual(candidate, password);
}

export function isAuthenticated(req: Request): boolean {
  const password = sharedPassword();
  if (!password) return false;
  return readCookies(req, COOKIE).some((token) => validToken(token, password));
}

// SameSite=None + Partitioned lets login work when the site is shown inside another page (e.g. a
// preview embedded in Netlify's UI). CSRF stays blocked: every write requires a JSON body, which
// cross-site pages can't send without a CORS preflight this API never approves.
const COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=None; Partitioned";

export function sessionCookie(): string {
  const password = sharedPassword()!;
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  const token = `${expires}.${sign(password, expires)}`;
  return `${COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_DAYS * 86400}`;
}

// Clears both the current partitioned cookie and the older SameSite=Strict one.
export function clearedCookies(): string[] {
  return [`${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`, `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`];
}

export function notConfigured(): Response {
  return Response.json(
    { error: "Login is not configured. Set INVENTORY_SHARED_PASSWORD in Netlify and redeploy." },
    { status: 503 },
  );
}
