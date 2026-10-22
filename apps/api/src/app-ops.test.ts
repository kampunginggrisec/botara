import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "./app";
import { testDeps } from "./test-helpers";

/** Fase 3 observability + security middleware behaviour. */

describe("/health/ready", () => {
  test("503 with a per-dependency breakdown when dependencies are down", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      dependencies: { database: { ok: boolean }; redis: { ok: boolean } };
    };
    expect(body.status).toBe("not-ready");
    expect(body.dependencies.database.ok).toBe(false);
    expect(body.dependencies.redis.ok).toBe(false);
  });

  test("200 ready when both probes pass; /health stays a dumb liveness check", async () => {
    const app = createApp(testDeps({
      readiness: {
        async checkDatabase() { return { ok: true }; },
        async checkRedis() { return { ok: true }; },
      },
    }));
    const ready = await app.request("/health/ready");
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { status: string }).status).toBe("ready");
    const live = await app.request("/health");
    expect(live.status).toBe(200);
  });
});

describe("security headers", () => {
  test("baseline headers on every response; HSTS only behind https", async () => {
    const app = createApp(testDeps());
    const http = await app.request("/health");
    expect(http.headers.get("x-content-type-options")).toBe("nosniff");
    expect(http.headers.get("x-frame-options")).toBe("DENY");
    expect(http.headers.get("referrer-policy")).toBe("no-referrer");
    expect(http.headers.get("strict-transport-security")).toBeNull();

    const https = await app.request("/health", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(https.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  test("every response carries an x-request-id and produces one structured log line", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const app = createApp(testDeps());
      const res = await app.request("/health");
      expect(res.headers.get("x-request-id")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    const line = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((l) => l && l.service === "api" && l.path === "/health");
    expect(line).toBeTruthy();
    expect(line.method).toBe("GET");
    expect(line.status).toBe(200);
    expect(typeof line.ms).toBe("number");
    expect(line.requestId).toBeTruthy();
  });
});

describe("CORS", () => {
  test("default: cross-origin is denied (no allow-origin header)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allowlisted origins are echoed with credentials; preflight short-circuits", async () => {
    const app = createApp(testDeps({
      env: { SESSION_SECRET: "s", CORS_ORIGINS: "https://app.botara.id, https://admin.botara.id" },
    }));
    const res = await app.request("/health", { headers: { origin: "https://app.botara.id" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.botara.id");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");

    const preflight = await app.request("/conversations", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.botara.id",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("webchat public endpoints are permissive (widget embedding) - any origin", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/public/webchat/ws-1/session", {
      method: "OPTIONS",
      headers: { origin: "https://any-customer-site.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("rate limiting", () => {
  test("/auth/* is limited per minute and answers a typed 429 with Retry-After", async () => {
    const app = createApp(testDeps({ rateLimits: { authPerMinute: 3 } }));
    const attempt = () => app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "password-123" }),
    });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  test("/public/* has its own bucket (webchat spam)", async () => {
    const app = createApp(testDeps({ rateLimits: { publicPerMinute: 2 } }));
    const hit = () => app.request("/public/webchat/ws-1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // The first two pass the limiter and fail honestly at the missing DB.
    expect((await hit()).status).toBe(503);
    expect((await hit()).status).toBe(503);
    expect((await hit()).status).toBe(429);
  });
});
