import type { Config } from "@netlify/functions";
import { checkPassword, clearedCookies, isConfigured, notConfigured, sessionCookie } from "../lib/auth.mjs";

export default async (req: Request) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/api/logout") {
    const headers = new Headers();
    for (const cookie of clearedCookies()) headers.append("set-cookie", cookie);
    return Response.json({ ok: true }, { headers });
  }

  if (!isConfigured()) return notConfigured();

  let body: { password?: unknown } = {};
  try {
    body = await req.json();
  } catch {}

  if (!checkPassword(body.password)) {
    return Response.json({ error: "Incorrect password" }, { status: 401 });
  }
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie() } });
};

export const config: Config = {
  path: ["/api/login", "/api/logout"],
  method: "POST",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
