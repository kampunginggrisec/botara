# Panduan Deploy Botara ke VPS (Produksi)

Panduan ini menyiapkan Botara di satu VPS dengan Docker Compose + Caddy
(HTTPS otomatis). Domain dan VPS bersifat *menyusul* — file deploy sudah
disiapkan dari sekarang, dan panduan ini dijalankan pada hari go-live.

## Yang sudah disiapkan di repo

- `Dockerfile` (root) — satu image multi-target: `api`, `worker`, `realtime`, `web`.
- `infra/docker/docker-compose.prod.yml` — Postgres 18 (pgvector), Redis, API,
  worker, realtime, web statis, dan Caddy sebagai satu-satunya layanan publik.
- `infra/deploy/Caddyfile` — reverse proxy dengan placeholder `{$DOMAIN}`:
  domain → web, `/api/*` → API (prefix dibuang), `/ws` → realtime.
- `.env.production.example` — template env produksi (placeholder saja).

## Langkah deploy

### 1. Install Docker Engine + Compose plugin

Di VPS (Ubuntu/Debian), ikuti panduan resmi Docker untuk memasang Docker
Engine dan plugin Compose v2, lalu pastikan perintah berikut bekerja:

```bash
docker version
docker compose version
```

### 2. Clone repo

```bash
git clone git@github.com:kampunginggrisec/botara.git
cd botara
```

### 3. Siapkan env produksi

```bash
cp .env.production.example .env.production
nano .env.production   # isi semua nilai asli DI VPS SAJA
```

Peringatan: `.env.production` berisi rahasia. Jangan pernah di-commit,
jangan dikirim lewat chat/email.

### 4. Generate secret

Setiap nilai rahasia dibuat acak di VPS:

```bash
openssl rand -hex 24   # contoh: POSTGRES_PASSWORD
openssl rand -hex 32   # contoh: TELEGRAM_WEBHOOK_SECRET, TOKEN_VAULT_KEY, SESSION_SECRET, JWT_SECRET
```

`WHATSAPP_VERIFY_TOKEN` boleh string acak buatan sendiri — nilainya harus
sama dengan yang dimasukkan di konfigurasi webhook aplikasi Meta.

### 5. Jalankan stack

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f infra/docker/docker-compose.prod.yml ps
```

### 6. Verifikasi

```bash
# Health API lewat proxy (menguji Caddy + routing /api sekaligus;
# prefix /api dibuang oleh proxy sehingga API menerima /health):
curl https://DOMAIN/api/health
# -> {"status":"ok","service":"api"}
```

Ganti `DOMAIN` dengan domain asli dari `.env.production`. Web dashboard
dibuka di `https://DOMAIN/`.

## Realtime (inbox live)

Layanan `realtime` membuat inbox dashboard memperbarui dirinya sendiri
(pesan masuk/balasan tampil tanpa refresh manual). Ia butuh tiga env:

- `SESSION_SECRET` — WAJIB sama persis dengan milik API (dari
  `.env.production` lewat env_file): realtime memverifikasi JWT sesi
  yang sama sebelum socket boleh berlangganan.
- `REDIS_URL=redis://redis:6379` — kanal pub/sub `botara:realtime`
  tempat API menerbitkan event `inbox.message` (sudah di-set sebagai
  environment pada service `realtime` di compose produksi).
- `BOTARA_API_URL=http://api:3000` — alamat API LANGSUNG untuk
  `GET /auth/me` (resolusi workspace per koneksi), TANPA prefix `/api`
  (sudah di-set di compose; layout native/trial memakai default
  `http://localhost:3001`).

Di server trial (systemd, tanpa Docker), unit `botara-realtime`
memakai EnvironmentFile `~/botara/.env` yang sama dengan API — file
itu sudah berisi `SESSION_SECRET` dan `REDIS_URL`, dan default
`BOTARA_API_URL` (`localhost:3001`) cocok dengan layout trial, jadi
tidak ada env tambahan yang perlu dibuat.

## URL webhook yang didaftarkan (setelah domain aktif)

Daftarkan URL berikut persis seperti ini:

- **WhatsApp (Meta App → WhatsApp → Configuration → Webhook):**
  - Callback URL: `https://DOMAIN/api/webhooks/whatsapp`
  - Verify token: nilai `WHATSAPP_VERIFY_TOKEN` dari `.env.production`
  - Langganan field: `messages` dan `message_template_category_update`
- **Telegram (Bot API setWebhook):**
  ```bash
  curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
    -d "url=https://DOMAIN/api/webhooks/telegram" \
    -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
  ```
  Sejak Fase 4, menghubungkan bot dari halaman **Channels** dashboard
  juga memanggil setWebhook otomatis ke URL yang sama bila
  `PUBLIC_WEBHOOK_BASE_URL` terisi.

## Onboarding channel dari dashboard (Fase 4)

Dashboard sekarang punya alur koneksi asli di halaman **Channels**
(Telegram via token bot, WhatsApp via Embedded Signup, Instagram /
Threads / Messenger via OAuth). Agar berfungsi di produksi, isi di
`.env.production`:

- `PUBLIC_WEBHOOK_BASE_URL=https://DOMAIN/api` — basis publik API
  (termasuk prefix `/api` dari reverse proxy). Dipakai untuk:
  - Redirect URI OAuth yang WAJIB didaftarkan persis di dashboard
    aplikasi Meta/Threads:
    - `https://DOMAIN/api/channels/instagram/oauth/callback`
    - `https://DOMAIN/api/channels/threads/oauth/callback`
    - `https://DOMAIN/api/channels/messenger/oauth/callback`
  - URL webhook Telegram saat bot dihubungkan dari dashboard:
    `https://DOMAIN/api/webhooks/telegram`
- `APP_PUBLIC_URL=https://DOMAIN` — tujuan redirect browser setelah
  OAuth selesai (halaman Channels SPA).
- `WHATSAPP_EMBEDDED_CONFIG_ID` — ID konfigurasi Embedded Signup dari
  dashboard aplikasi Meta. Tombol "Connect WhatsApp" hanya muncul bila
  ini dan `META_APP_ID` terisi; bila kosong, dashboard menampilkan
  status "belum dikonfigurasi" secara jujur.
- `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` — kredensial Instagram
  Login (Business Login for Instagram); kosong = fallback ke
  `META_APP_ID` / `META_APP_SECRET`.

Tanpa variabel-variabel ini, endpoint OAuth membalas 503 CONFIGURATION
dan kartu koneksi menampilkan status belum terkonfigurasi — tidak ada
alur yang berpura-pura berhasil.

## MCP server (opsional)

Compose production menyediakan service `mcp` di balik profile `mcp`
(lihat `docs/mcp.md`). Variabel yang relevan di `.env.production`:

- `PORT_MCP=3003` — port transport HTTP MCP (bind `127.0.0.1` saja).
- `BOTARA_API_TOKEN` — token API personal (`bta_...`) milik satu user,
  dibuat dari dashboard Settings -> API tokens. Server MCP menolak start
  tanpa token ini.
- `BOTARA_API_URL` — di-override oleh compose ke `http://api:3000`
  (koneksi internal antar-container).

Aktifkan dengan `docker compose ... --profile mcp up -d mcp`. Jangan
mengekspos port MCP ke publik tanpa TLS + auth di reverse proxy:
token di dalamnya setara akses API penuh milik user tersebut.

## Update (rilis baru)

```bash
cd botara
git pull
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.production up -d --build
```

## Rollback

Jika rilis baru bermasalah, kembali ke commit sebelumnya lalu build ulang:

```bash
git log --oneline -5          # catat commit terakhir yang sehat
git checkout <commit-sehat>
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.production up -d --build
```

Data Postgres/Redis berada di named volume dan tidak ikut terhapus oleh
rollback kode. Jangan menjalankan `docker compose down -v` di produksi
(perintah itu menghapus volume = menghapus data).

## Backup Postgres

Contoh backup manual ke file bertanggal:

```bash
docker compose -f infra/docker/docker-compose.prod.yml exec -T postgres \
  pg_dump -U botara -d botara > backup-$(date +%Y%m%d-%H%M).sql
```

Contoh cron harian (pukul 02:30) — sesuaikan path:

```cron
30 2 * * * cd /path/ke/botara && docker compose -f infra/docker/docker-compose.prod.yml exec -T postgres pg_dump -U botara -d botara > /var/backups/botara-$(date +\%Y\%m\%d).sql
```

Simpan juga salinan backup di luar VPS (mis. bucket R2 terpisah).

## Yang masih harus disiapkan pada hari go-live

1. **Domain asli + DNS**: buat A record domain → IP publik VPS, tunggu
   propagasi. Caddy menerbitkan sertifikat HTTPS otomatis setelah DNS benar.
2. **Kredensial aplikasi Meta**: App ID/Secret, token WhatsApp, dan verify
   token — isi ke `.env.production`.
3. **Bucket Cloudflare R2** + custom domain untuk media publik, lalu isi
   variabel `R2_*`.
4. **Domain email terverifikasi di Resend** (DKIM/SPF/DMARC), lalu isi
   `RESEND_API_KEY` dan `RESEND_FROM_EMAIL`.
5. Daftarkan URL webhook di atas ke Meta dan Telegram.
