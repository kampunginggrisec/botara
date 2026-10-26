# Admin Panel — Operator Guide

The admin panel is Botara's **platform operator** surface: it belongs to
the person who runs the deployment, not to any workspace. It lives in the
web app at the **Admin** nav item (visible only to platform admins) and is
backed by `/admin/*` API routes that require a session whose user carries
`users.is_platform_admin`.

What it shows:

- **Overview** — total users / workspaces / channel accounts (per
  channel), message totals, **active users** (successful logins in the
  last 7 / 30 days, from `users.last_login_at`), recent registrations.
- **Users** — every account with its workspaces + roles, registration and
  last-login times, and grant/revoke controls for the platform-admin flag.
- **Workspaces** — every workspace with owner, member count, channel
  account count, and message count.
- **Billing** — per-workspace **usage/cost visibility** aggregated from
  the WhatsApp cost ledger (`cost_ledger`): billable units and rated cost
  by message category over 7 / 30 / 90 days, plus platform totals. This is
  monitoring only — there is **no subscription charging, invoicing, or
  payment collection** in Botara today.
- **Settings** — the platform settings described below.
- **Audit** — the most recent audit-log rows across the deployment
  (logins, registrations, vault writes, member changes, admin actions).

## Bootstrap rule: the first registered user becomes platform admin

On a fresh deployment the `users` table is empty. **The first user who
registers automatically becomes platform admin** — the registration
handler grants the flag only when the table is empty, and the database
store re-checks that condition atomically at insert time, so two
simultaneous first registrations cannot both win.

> **⚠️ Register immediately on public domains.** If the deployment is
> reachable on a public URL, the first person to register — anyone —
> becomes the operator. On a fresh install, register your own account
> FIRST, before announcing or sharing the URL. Afterwards, grant the
> flag to additional operators from Admin → Users.

Invited workspace members do **not** get the flag: claiming an invited
account is not a first registration, and a deployment that already has
users never grants it implicitly again.

Further rules enforced by the API:

- Platform admins can grant/revoke the flag for other users.
- The **last** platform admin can never be revoked (the API answers
  409) — grant a second admin first.
- Every grant/revoke and every settings write lands in the audit log
  (key names and target ids only — never values).

## Platform settings: panel first, `.env` as fallback

App credentials and provider configuration are managed **from the
panel** (Admin → Settings) and stored in the `platform_settings` table.
Resolution order everywhere is:

```
DB setting  →  environment variable  →  unset
```

- Non-secret values are stored as plaintext rows; **secrets are stored
  AES-256-GCM-encrypted** with `TOKEN_VAULT_KEY` (the same scheme as the
  channel token vault). The API never returns a secret value — for
  secrets the panel shows only whether a value is set and where it came
  from (Panel / Env / Not set). Non-secret values (app ids, config) ARE
  returned, so their inputs are prefilled with the current value.
- The Settings tab is laid out as **platform cards** (Meta, Instagram,
  Threads, TikTok): each card carries an honest "Configured" badge
  derived from the keys that are effectively set, the callback/webhook
  URLs to paste into that provider's console (from
  `GET /admin/connection-info`), and the group's credential fields.
  All three Meta-family cards (Meta, Instagram, Threads) show the SAME
  data-deletion URL: Botara's single deletion endpoint verifies signed
  requests against all three app secrets (Meta, Instagram, Threads —
  each per-app secret falling back to the Meta app secret), so one URL
  is registered in all three app consoles. Telegram and Resend webhooks
  live in a slim "Other endpoints" card; the Telegram, Storage, Email
  and AI groups keep the plain group-card form below.
- Saving in the panel applies to the API process immediately; the API and
  worker processes also re-read the database every ~60 seconds, so an
  edit propagates to every service within about a minute. Clearing a
  Panel value removes the DB row and the env fallback (if any) applies
  again.
- Keep the `.env` values as your fallback/bootstrap copy: they are what
  the deployment uses until the panel holds a value, and they are the
  recovery path if the database is restored from an old backup.

### Managed keys

| Group | Keys |
|---|---|
| Meta | `META_APP_ID`, `META_APP_SECRET`*, `META_GRAPH_VERSION`, `META_VERIFY_TOKEN`*, `WHATSAPP_VERIFY_TOKEN`*, `WHATSAPP_EMBEDDED_CONFIG_ID`, `WHATSAPP_ACCESS_TOKEN`*, `MESSENGER_ACCESS_TOKEN`* |
| Threads | `THREADS_APP_ID`, `THREADS_APP_SECRET`*, `THREADS_VERIFY_TOKEN`*, `THREADS_ACCESS_TOKEN`* |
| Instagram | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`*, `INSTAGRAM_ACCESS_TOKEN`* |
| TikTok | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`*, `TIKTOK_ACCESS_TOKEN`* |
| Telegram | `TELEGRAM_BOT_TOKEN`*, `TELEGRAM_WEBHOOK_SECRET`* |
| Storage (R2) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`*, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` |
| Email (Resend) | `RESEND_API_KEY`*, `RESEND_WEBHOOK_SECRET`* |
| AI | `AI_API_KEY`*, `AI_BASE_URL`, `AI_MODEL`, `AI_EMBEDDING_MODEL` |

`*` = stored encrypted. Only env vars the code actually reads are
managed — e.g. `RESEND_FROM_EMAIL` is intentionally absent (it exists in
the env examples/schema, but no runtime code consumes it; the email
adapter sends from the channel account's address).

### NOT panel-managed: bootstrap secrets

These stay in `.env` / process environment only, by design:

- `TOKEN_VAULT_KEY` — it encrypts the settings themselves; a key cannot
  be stored under itself.
- `SESSION_SECRET` — session signing must work before any DB read, and
  the realtime service (which has no database connection) verifies
  session tokens with it.
- `DATABASE_URL`, `REDIS_URL` — the coordinates needed to reach the
  database/cache in the first place.
- `PORT_API` / `PORT_REALTIME` / `PORT_MCP` and host basics — process
  wiring, read once at boot by the runtime.

Changing any of these still means editing the environment and restarting
the affected services.

## "Active users" — the honest definition

Active-user counts are **users with a successful login** inside the
window (`users.last_login_at`, stamped by `POST /auth/login`). Personal
API-token (`bta_…`) requests do not stamp it, and a user who registered
but never logged in counts only in totals until their first login. Note
registration also issues a session, but `last_login_at` is stamped by the
login endpoint specifically.
