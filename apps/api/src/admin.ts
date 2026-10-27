import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "@botara/shared";
import {
  countActiveUsers, countChannelAccountsByChannel, countMessages, countUsers, countWorkspaces,
  getPlatformBilling, listRecentAuditLogs, listRecentUsers, listUsersAdmin, listWorkspacesAdmin,
  type Database, type PlatformBillingRow, type PlatformSettingsService,
} from "@botara/db";
import { requirePlatformAdmin, type AuthStore, type AuthUser } from "./auth";
import type { AppEnv } from "./app";
import {
  listWebhookReceiptItems,
  type WebhookReceiptItem,
} from "./webhook-receipts";

/**
 * Platform admin (operator panel) - Fase: admin panel.
 *
 * Everything under /admin is deployment-scoped, NOT workspace-scoped: it
 * serves the deployment's operator (users.is_platform_admin), never a
 * workspace role. Every route requires an authenticated platform admin
 * (401 unauthenticated, 403 for non-admins) and every mutation is written
 * to the audit log. Billing here is usage/cost VISIBILITY over the
 * WhatsApp cost ledger (cost_ledger) - no subscription charging exists.
 */

// ------------------------------------------------------------------- views

export interface AdminOverview {
  totals: {
    users: number;
    workspaces: number;
    channelAccounts: number;
    messages: number;
    messagesLast30d: number;
  };
  channelAccountsByChannel: Array<{ channel: string; count: number }>;
  /** Users with a successful login inside the window (users.last_login_at). */
  activeUsers: { last7d: number; last30d: number };
  recentRegistrations: Array<{ id: string; email: string; name: string | null; createdAt: string }>;
}

export interface AdminUserItem {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  isPlatformAdmin: boolean;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

export interface AdminWorkspaceItem {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  memberCount: number;
  channelAccountCount: number;
  messageCount: number;
  createdAt: string;
}

export interface AdminBillingCategory {
  category: string;
  units: number;
  entries: number;
  amount: number;
}

export interface AdminBillingWorkspace {
  workspaceId: string;
  workspaceName: string;
  currency: string;
  units: number;
  entries: number;
  amount: number;
  byCategory: AdminBillingCategory[];
}

export interface AdminBilling {
  workspaces: AdminBillingWorkspace[];
  totals: Array<{ currency: string; units: number; entries: number; amount: number }>;
}

export interface AdminAuditItem {
  id: string;
  action: string;
  actorEmail: string | null;
  userId: string | null;
  workspaceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

// ------------------------------------------------------------- billing math

/** Group flat per-(workspace, category, currency) ledger rows into the API shape. */
export function groupBillingRows(rows: PlatformBillingRow[]): AdminBilling {
  const byWorkspace = new Map<string, AdminBillingWorkspace>();
  const totalsByCurrency = new Map<string, { currency: string; units: number; entries: number; amount: number }>();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.currency}`;
    let ws = byWorkspace.get(key);
    if (!ws) {
      ws = {
        workspaceId: row.workspaceId, workspaceName: row.workspaceName, currency: row.currency,
        units: 0, entries: 0, amount: 0, byCategory: [],
      };
      byWorkspace.set(key, ws);
    }
    ws.units += row.units;
    ws.entries += row.entries;
    ws.amount += row.amount;
    ws.byCategory.push({ category: row.category, units: row.units, entries: row.entries, amount: row.amount });
    const total = totalsByCurrency.get(row.currency) ?? { currency: row.currency, units: 0, entries: 0, amount: 0 };
    total.units += row.units;
    total.entries += row.entries;
    total.amount += row.amount;
    totalsByCurrency.set(row.currency, total);
  }
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  for (const ws of byWorkspace.values()) {
    ws.amount = round(ws.amount);
    for (const cat of ws.byCategory) cat.amount = round(cat.amount);
  }
  const totals = [...totalsByCurrency.values()].map((t) => ({ ...t, amount: round(t.amount) }));
  return { workspaces: [...byWorkspace.values()], totals };
}

// ------------------------------------------------------------------- store

/** Everything the admin read views need from persistence. */
/** One inbound webhook receipt as the Admin → Webhook log shows it. */
export type AdminWebhookLogItem = WebhookReceiptItem;

export interface AdminStore {
  overview(now: Date): Promise<AdminOverview>;
  listUsers(): Promise<AdminUserItem[]>;
  listWorkspaces(): Promise<AdminWorkspaceItem[]>;
  billing(since: Date): Promise<AdminBilling>;
  audit(limit: number): Promise<AdminAuditItem[]>;
  /** Newest inbound webhook receipts (Admin → Webhook log). */
  webhookLog(filters: {
    channel?: string;
    outcome?: string;
    limit: number;
  }): Promise<AdminWebhookLogItem[]>;
}

const DAY_MS = 24 * 3600 * 1000;
const isoOrNull = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Production AdminStore over the Drizzle repositories. */
export class DbAdminStore implements AdminStore {
  constructor(private readonly getDatabase: () => Database) {}

  async overview(now: Date): Promise<AdminOverview> {
    const db = this.getDatabase();
    const [
      users, workspaces, byChannel, messages, messagesLast30d,
      active7d, active30d, recent,
    ] = await Promise.all([
      countUsers(db),
      countWorkspaces(db),
      countChannelAccountsByChannel(db),
      countMessages(db),
      countMessages(db, new Date(now.getTime() - 30 * DAY_MS)),
      countActiveUsers(db, new Date(now.getTime() - 7 * DAY_MS)),
      countActiveUsers(db, new Date(now.getTime() - 30 * DAY_MS)),
      listRecentUsers(db, 5),
    ]);
    return {
      totals: {
        users,
        workspaces,
        channelAccounts: byChannel.reduce((sum, r) => sum + r.count, 0),
        messages,
        messagesLast30d,
      },
      channelAccountsByChannel: byChannel,
      activeUsers: { last7d: active7d, last30d: active30d },
      recentRegistrations: recent.map((u) => ({
        id: u.id, email: u.email, name: u.name, createdAt: u.createdAt.toISOString(),
      })),
    };
  }

  async listUsers(): Promise<AdminUserItem[]> {
    const rows = await listUsersAdmin(this.getDatabase());
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: isoOrNull(u.lastLoginAt),
      isPlatformAdmin: u.isPlatformAdmin,
      workspaces: u.memberships.map((m) => ({ id: m.workspaceId, name: m.workspaceName, role: m.role })),
    }));
  }

  async listWorkspaces(): Promise<AdminWorkspaceItem[]> {
    const rows = await listWorkspacesAdmin(this.getDatabase());
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      ownerEmail: w.ownerEmail,
      memberCount: w.memberCount,
      channelAccountCount: w.channelAccountCount,
      messageCount: w.messageCount,
      createdAt: w.createdAt.toISOString(),
    }));
  }

  async billing(since: Date): Promise<AdminBilling> {
    return groupBillingRows(await getPlatformBilling(this.getDatabase(), since));
  }

  async audit(limit: number): Promise<AdminAuditItem[]> {
    const rows = await listRecentAuditLogs(this.getDatabase(), limit);
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorEmail: r.actorEmail,
      userId: r.userId,
      workspaceId: r.workspaceId,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async webhookLog(filters: {
    channel?: string;
    outcome?: string;
    limit: number;
  }): Promise<AdminWebhookLogItem[]> {
    return listWebhookReceiptItems(this.getDatabase, filters);
  }
}

// ------------------------------------------------------- in-memory (tests)

export interface InMemoryLedgerRow {
  workspaceId: string;
  workspaceName: string;
  category: string;
  currency: string;
  units: number;
  amount: number;
  createdAt: Date;
}

export interface InMemoryAdminUser extends Omit<AdminUserItem, "createdAt" | "lastLoginAt"> {
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** In-memory AdminStore for tests (and only tests). Seed the public arrays. */
export class InMemoryAdminStore implements AdminStore {
  users: InMemoryAdminUser[] = [];
  workspaces: Array<Omit<AdminWorkspaceItem, "createdAt"> & { createdAt: Date }> = [];
  channelAccountsByChannel: Array<{ channel: string; count: number }> = [];
  messagesTotal = 0;
  messagesLast30d = 0;
  ledger: InMemoryLedgerRow[] = [];
  auditRows: Array<Omit<AdminAuditItem, "createdAt"> & { createdAt: Date }> = [];

  async overview(now: Date): Promise<AdminOverview> {
    const active = (days: number) =>
      this.users.filter((u) => u.lastLoginAt && u.lastLoginAt.getTime() >= now.getTime() - days * DAY_MS).length;
    return {
      totals: {
        users: this.users.length,
        workspaces: this.workspaces.length,
        channelAccounts: this.channelAccountsByChannel.reduce((s, r) => s + r.count, 0),
        messages: this.messagesTotal,
        messagesLast30d: this.messagesLast30d,
      },
      channelAccountsByChannel: this.channelAccountsByChannel,
      activeUsers: { last7d: active(7), last30d: active(30) },
      recentRegistrations: [...this.users]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 5)
        .map((u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt.toISOString() })),
    };
  }

  async listUsers(): Promise<AdminUserItem[]> {
    return this.users.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: isoOrNull(u.lastLoginAt),
    }));
  }

  async listWorkspaces(): Promise<AdminWorkspaceItem[]> {
    return this.workspaces.map((w) => ({ ...w, createdAt: w.createdAt.toISOString() }));
  }

  async billing(since: Date): Promise<AdminBilling> {
    const grouped = new Map<string, PlatformBillingRow>();
    for (const row of this.ledger) {
      if (row.createdAt < since) continue;
      const key = `${row.workspaceId}:${row.category}:${row.currency}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.units += row.units;
        existing.amount += row.amount;
        existing.entries += 1;
      } else {
        grouped.set(key, {
          workspaceId: row.workspaceId, workspaceName: row.workspaceName,
          category: row.category, currency: row.currency,
          units: row.units, amount: row.amount, entries: 1,
        });
      }
    }
    return groupBillingRows([...grouped.values()]);
  }

  async audit(limit: number): Promise<AdminAuditItem[]> {
    return [...this.auditRows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** Seed newest-first, exactly as the recorder stores them. */
  webhookReceipts: AdminWebhookLogItem[] = [];

  async webhookLog(filters: {
    channel?: string;
    outcome?: string;
    limit: number;
  }): Promise<AdminWebhookLogItem[]> {
    return this.webhookReceipts
      .filter((r) => !filters.channel || r.channel === filters.channel)
      .filter((r) => !filters.outcome || r.outcome === filters.outcome)
      .slice(0, filters.limit);
  }
}

// ------------------------------------------------------------------ routes

export interface AdminRouteDeps {
  /** app.ts's authenticateRequest: 401 unauthenticated, else the user. */
  authenticate(c: Context<AppEnv>): Promise<AuthUser>;
  authStore: AuthStore;
  adminStore: AdminStore;
  platformSettings: PlatformSettingsService;
  /** app.ts's publicApiBase: the API's public base URL for this request. */
  publicApiBase(c: Context<AppEnv>): string;
}

/**
 * Connection reference payload (Admin → Settings): every callback URL an
 * operator must paste into a provider dashboard, computed from the same
 * public base the OAuth flows use. Verify-token entries carry the
 * settings KEY NAME only — values are secrets and never leave the vault.
 */
export interface AdminConnectionInfo {
  base: string;
  webhooks: Array<{
    id: string;
    url: string;
    verifyTokenKey: string | null;
    /** True when Botara registers the webhook itself at connect time. */
    autoConfigured: boolean;
  }>;
  oauthRedirects: Array<{ id: string; url: string }>;
}

interface SettingUpdateInput {
  key: string;
  value?: string;
  clear?: boolean;
}

async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AppError("VALIDATION", "Request body must be a JSON object.", { status: 400 });
  }
}

function parseDays(raw: string | undefined): number {
  const days = Number(raw ?? "30");
  if (!Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, Math.floor(days)));
}

function parseLimit(raw: string | undefined): number {
  const limit = Number(raw ?? "50");
  if (!Number.isFinite(limit)) return 50;
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

/**
 * Register every /admin route on the app. All routes share the guard:
 * authenticate (401) + requirePlatformAdmin (403). Platform scope only -
 * no X-Workspace-Id is read or honored here.
 */
export function registerAdminRoutes(app: OpenAPIHono<AppEnv>, deps: AdminRouteDeps): void {
  const guard = async (c: Context<AppEnv>): Promise<AuthUser> => {
    const user = await deps.authenticate(c);
    requirePlatformAdmin(user);
    return user;
  };

  app.get("/admin/overview", async (c) => {
    await guard(c);
    return c.json(await deps.adminStore.overview(new Date()));
  });

  app.get("/admin/users", async (c) => {
    await guard(c);
    return c.json({ users: await deps.adminStore.listUsers() });
  });

  app.get("/admin/workspaces", async (c) => {
    await guard(c);
    return c.json({ workspaces: await deps.adminStore.listWorkspaces() });
  });

  app.get("/admin/billing", async (c) => {
    await guard(c);
    const days = parseDays(c.req.query("days"));
    const since = new Date(Date.now() - days * DAY_MS);
    return c.json({ days, ...(await deps.adminStore.billing(since)) });
  });

  app.get("/admin/settings", async (c) => {
    await guard(c);
    return c.json({ settings: await deps.platformSettings.listViews() });
  });

  app.put("/admin/settings", async (c) => {
    const admin = await guard(c);
    const body = await readJsonObject(c);
    const updates = body.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new AppError("VALIDATION", "Body must carry a non-empty `updates` list.", { status: 400 });
    }
    const setKeys: string[] = [];
    const clearedKeys: string[] = [];
    for (const raw of updates as SettingUpdateInput[]) {
      if (!raw || typeof raw.key !== "string") {
        throw new AppError("VALIDATION", "Every update needs a string `key`.", { status: 400 });
      }
      if (raw.clear === true) {
        await deps.platformSettings.clearValue(raw.key, admin.id);
        clearedKeys.push(raw.key);
      } else if (typeof raw.value === "string") {
        await deps.platformSettings.setValue(raw.key, raw.value, admin.id);
        setKeys.push(raw.key);
      } else {
        throw new AppError("VALIDATION", `Update for "${raw.key}" needs a string \`value\` or \`clear: true\`.`, { status: 400 });
      }
    }
    // Audit key NAMES only - a settings value (secret or not) never enters the log.
    await deps.authStore.audit({
      userId: admin.id,
      action: "admin.settings.update",
      details: { set: setKeys, cleared: clearedKeys },
    });
    return c.json({ settings: await deps.platformSettings.listViews() });
  });

  app.get("/admin/audit", async (c) => {
    await guard(c);
    return c.json({ entries: await deps.adminStore.audit(parseLimit(c.req.query("limit"))) });
  });

  app.get("/admin/webhook-log", async (c) => {
    await guard(c);
    const channel = c.req.query("channel") || undefined;
    const outcome = c.req.query("outcome") || undefined;
    const receipts = await deps.adminStore.webhookLog({
      channel,
      outcome,
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json({ receipts });
  });

  app.get("/admin/connection-info", async (c) => {
    await guard(c);
    const base = deps.publicApiBase(c);
    const webhook = (
      id: string,
      path: string,
      verifyTokenKey: string | null,
      autoConfigured = false,
    ): AdminConnectionInfo["webhooks"][number] => ({ id, url: `${base}${path}`, verifyTokenKey, autoConfigured });
    const info: AdminConnectionInfo = {
      base,
      webhooks: [
        webhook("whatsapp", "/webhooks/whatsapp", "WHATSAPP_VERIFY_TOKEN"),
        webhook("messenger", "/webhooks/messenger", "META_VERIFY_TOKEN"),
        webhook("instagram", "/webhooks/instagram", "META_VERIFY_TOKEN"),
        webhook("threads", "/webhooks/threads", "THREADS_VERIFY_TOKEN"),
        webhook("tiktok", "/webhooks/tiktok", null),
        // Telegram: the connect flow calls setWebhook itself — the URL is
        // listed so operators can verify what is registered, not paste it.
        webhook("telegram", "/webhooks/telegram", null, true),
        webhook("resend", "/webhooks/resend", null),
        webhook("meta-data-deletion", "/webhooks/meta/data-deletion", null),
      ],
      oauthRedirects: ["messenger", "instagram", "threads", "tiktok"].map((id) => ({
        id,
        url: `${base}/channels/${id}/oauth/callback`,
      })),
    };
    return c.json(info);
  });

  app.post("/admin/users/:id/platform-admin", async (c) => {
    const admin = await guard(c);
    const targetId = c.req.param("id");
    const body = await readJsonObject(c);
    if (typeof body.grant !== "boolean") {
      throw new AppError("VALIDATION", "Body must carry `grant` as a boolean.", { status: 400 });
    }
    const target = await deps.authStore.findUserById(targetId);
    if (!target) {
      throw new AppError("NOT_FOUND", "User not found.", { status: 404 });
    }
    if (body.grant === false && target.isPlatformAdmin) {
      // The last platform admin can never be revoked - the panel would lock everyone out.
      const admins = await deps.authStore.countPlatformAdmins();
      if (admins <= 1) {
        throw new AppError(
          "CONFLICT",
          "Cannot revoke the last platform administrator. Grant the flag to another user first.",
          { status: 409 },
        );
      }
    }
    if (target.isPlatformAdmin !== body.grant) {
      await deps.authStore.setPlatformAdmin(targetId, body.grant);
      await deps.authStore.audit({
        userId: admin.id,
        action: "admin.users.platform_admin",
        details: { targetUserId: targetId, targetEmail: target.email, grant: body.grant },
      });
    }
    return c.json({ user: { id: targetId, isPlatformAdmin: body.grant } });
  });
}
