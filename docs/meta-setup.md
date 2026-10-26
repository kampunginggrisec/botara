# Panduan Setup Meta untuk Operator Botara

Panduan lengkap menyiapkan dan menyelesaikan integrasi aplikasi Meta
(WhatsApp, Messenger, Instagram, Threads) untuk satu deployment Botara.
Ditulis untuk **pemilik/operator deployment** — orang yang memegang akun
Meta dan mengisi dashboard developers.facebook.com. Semua URL, nama
field, dan nama kunci di dokumen ini diambil dari kode Botara saat ini;
kalau dashboard Meta berubah, kode adalah acuan akhirnya.

Contoh berjalan di dokumen ini memakai domain trial
`https://dev.botara.my.id`. Untuk deployment produksi, ganti dengan
domain produksi Anda di semua tempat — strukturnya tidak berubah.

Dokumen pendamping:

- `docs/whatsapp-saas-meta-dev.md` — runbook ringkas khusus operator SaaS:
  model kepemilikan pelanggan, Embedded Signup, coexistence, dan go-live.
- `docs/admin-panel.md` — cara kerja Panel Admin dan pengaturan platform.
- `docs/app-review/` — paket App Review: justifikasi izin siap tempel
  (`permissions.md`), naskah screencast (`screencast-scripts.md`), dan
  checklist pengajuan (`submission-checklist.md`). Panduan ini **tidak**
  menduplikasi paket itu; bagian App Review di bawah hanya merangkum.

---

## 1. Ringkasan arsitektur

Botara memakai **dua aplikasi Meta**:

1. **Satu app Meta utama** (tipe Business) untuk WhatsApp + Messenger +
   Instagram + Pages.
2. **Satu app Threads terpisah** — Threads punya App ID dan App Secret
   sendiri (`THREADS_APP_ID` / `THREADS_APP_SECRET`), terpisah dari app
   utama.

Semua URL publik Botara dibangun dari dua nilai dasar:

| Nilai | Isi | Contoh trial |
|---|---|---|
| `APP_PUBLIC_URL` | Origin aplikasi web (tanpa `/api`) | `https://dev.botara.my.id` |
| `PUBLIC_WEBHOOK_BASE_URL` | Basis URL API publik — **wajib diakhiri `/api`** | `https://dev.botara.my.id/api` |

Kode membangun URL webhook dan URL callback OAuth dengan menempelkan
path ke `PUBLIC_WEBHOOK_BASE_URL` (fallback: `APP_PUBLIC_URL`). Jadi
kalau `PUBLIC_WEBHOOK_BASE_URL` salah atau tidak diakhiri `/api`, semua
URL di bawah ini ikut salah.

Tabel induk — satu baris per permukaan Meta:

| Kanal | URL Webhook (GET verifikasi + POST event) | Token verifikasi yang diperiksa Botara | Secret penanda tangan POST | URL callback OAuth |
|---|---|---|---|---|
| WhatsApp | `{PUBLIC_WEBHOOK_BASE_URL}/webhooks/whatsapp` | `WHATSAPP_VERIFY_TOKEN` | `META_APP_SECRET` | — (Embedded Signup, tanpa redirect OAuth) |
| Messenger | `{PUBLIC_WEBHOOK_BASE_URL}/webhooks/messenger` | `META_VERIFY_TOKEN`, fallback `WHATSAPP_VERIFY_TOKEN` | `META_APP_SECRET` | `{PUBLIC_WEBHOOK_BASE_URL}/channels/messenger/oauth/callback` |
| Instagram | `{PUBLIC_WEBHOOK_BASE_URL}/webhooks/instagram` | `META_VERIFY_TOKEN`, fallback `WHATSAPP_VERIFY_TOKEN` | `META_APP_SECRET` | `{PUBLIC_WEBHOOK_BASE_URL}/channels/instagram/oauth/callback` |
| Threads | `{PUBLIC_WEBHOOK_BASE_URL}/webhooks/threads` | `THREADS_VERIFY_TOKEN`, fallback `META_VERIFY_TOKEN`, lalu `WHATSAPP_VERIFY_TOKEN` | `THREADS_APP_SECRET`, fallback `META_APP_SECRET` | `{PUBLIC_WEBHOOK_BASE_URL}/channels/threads/oauth/callback` |
| Penghapusan data | `POST {PUBLIC_WEBHOOK_BASE_URL}/webhooks/meta/data-deletion` | — (memakai `signed_request`) | `META_APP_SECRET`, `INSTAGRAM_APP_SECRET`, atau `THREADS_APP_SECRET` — endpoint menerima tanda tangan dari ketiga aplikasi (secret per-app fallback ke `META_APP_SECRET`; minimal satu **wajib ada**) | — |

Dengan contoh trial, URL-nya menjadi:

- Webhook WhatsApp: `https://dev.botara.my.id/api/webhooks/whatsapp`
- Webhook Messenger: `https://dev.botara.my.id/api/webhooks/messenger`
- Webhook Instagram: `https://dev.botara.my.id/api/webhooks/instagram`
- Webhook Threads: `https://dev.botara.my.id/api/webhooks/threads`
- Callback OAuth Messenger: `https://dev.botara.my.id/api/channels/messenger/oauth/callback`
- Callback OAuth Instagram: `https://dev.botara.my.id/api/channels/instagram/oauth/callback`
- Callback OAuth Threads: `https://dev.botara.my.id/api/channels/threads/oauth/callback`
- Penghapusan data: `https://dev.botara.my.id/api/webhooks/meta/data-deletion`

Dua keluarga URL yang **sering tertukar** — bedakan baik-baik:

- **URL webhook** (`.../webhooks/<kanal>`) diisi di konfigurasi
  **Webhook** produk, bersama token verifikasi.
- **URL callback OAuth** (`.../channels/<kanal>/oauth/callback`) diisi
  di **Valid OAuth Redirect URIs** pada produk login (Facebook Login /
  Instagram Login / Threads). Ini alamat kembalinya browser pengguna
  setelah login — **bukan** URL webhook. Menempel URL OAuth ke kolom
  webhook adalah penyebab error paling umum (lihat Troubleshooting 12a).

Botara **tidak** menyediakan callback deauthorize khusus; satu-satunya
callback siklus hidup akun yang diimplementasikan adalah penghapusan
data di atas.

Cara kerja verifikasi webhook (semua kanal): Meta mengirim
`GET ...?hub.mode=subscribe&hub.verify_token=<nilai>&hub.challenge=<acak>`.
Botara membalas isi `hub.challenge` apa adanya **hanya jika**
`hub.verify_token` sama persis dengan token yang dikonfigurasi untuk
kanal itu (lihat kolom ketiga tabel induk). Token salah → HTTP 403 dan
Meta menolak menyimpan konfigurasi. Setelah terverifikasi, event POST
ditandatangani Meta dengan header `X-Hub-Signature-256`; Botara
memeriksanya memakai App Secret pada tabel induk — **tetapi hanya jika
secret itu dikonfigurasi**. Mengisi App Secret bukan hanya syarat App
Review: tanpa secret, pemeriksaan tanda tangan dilewati.

---

## 2. Persiapan akun dan aplikasi

1. **Akun developer Meta** dalam keadaan baik, dan **bisnis
   terverifikasi** (Business Settings → Business Info). Verifikasi
   bisnis bisa memakan waktu berhari-hari — mulai dari sini dulu.
2. **Buat app Meta utama**: tipe **Business**, tambahkan use case/produk
   **WhatsApp**, **Messenger**, **Instagram**, dan **Pages** sesuai
   kebutuhan. Catat **App ID**-nya.
3. **Buat app Threads terpisah** dan catat App ID-nya sendiri.
4. **Deployment Botara live** di domain publik HTTPS, dan **akun
   operator sudah terdaftar** di Botara (pendaftar pertama menjadi
   platform admin — lihat `docs/admin-panel.md`).
5. Di app utama → **Settings → Basic**, isi:
   - **App Domains**: domain deployment saja, mis. `dev.botara.my.id`.
   - **Website URL**: `https://dev.botara.my.id/`
   - **Privacy Policy URL**: `https://dev.botara.my.id/privacy`
   - **Terms of Service URL**: `https://dev.botara.my.id/terms`
   - **Data Deletion Request URL**: URL penghapusan data dari tabel
     induk (`https://dev.botara.my.id/api/webhooks/meta/data-deletion`).
   - Halaman `/privacy` dan `/terms` di Botara adalah **template** —
     finalkan teksnya (nama legal bisnis, alamat, email kontak privasi)
     sebelum mengajukan App Review; peninjau Meta membukanya.
6. Ulangi isian dasar yang diminta pada app Threads (domain + URL
   kebijakan), sesuai wizard app Threads.

> App ID dan Configuration ID adalah **identifier**, bukan rahasia —
> aman dicatat dan dibagikan. App Secret adalah rahasia: masukkan hanya
> lewat Panel Admin (bagian 3) atau Secure Vault ke `.env` server.
> Jangan pernah menaruh App Secret di chat, git, atau dokumen ini.

---

## 3. Kredensial: Panel Admin dulu, `.env` sebagai fallback

Semua kredensial Meta dikelola dari **Panel Admin Botara → Admin →
Settings**. Nilai di database **menang atas** `.env`; urutan resolusi di
semua layanan adalah:

```
DB (panel)  →  environment variable  →  kosong
```

Secret tersimpan terenkripsi AES-256-GCM; panel hanya menampilkan
apakah nilai terisi dan sumbernya (Panel / Env / Not set), tidak pernah
nilainya. Perubahan panel berlaku di API seketika dan menyebar ke
worker dalam ±1 menit. Detail lengkap: `docs/admin-panel.md`.

Kunci yang relevan untuk Meta:

| Kunci | Grup panel | Rahasia? | Keterangan |
|---|---|---|---|
| `META_APP_ID` | Meta | Tidak | App ID app utama; mengaktifkan connect OAuth + Embedded Signup. |
| `META_APP_SECRET` | Meta | **Ya** | Memverifikasi tanda tangan webhook + `signed_request` penghapusan data. |
| `META_GRAPH_VERSION` | Meta | Tidak | Versi Graph API yang dipin (default `v26.0`). |
| `META_VERIFY_TOKEN` | Meta | **Ya** | Token verifikasi webhook Messenger/Instagram; fallback untuk Threads. |
| `WHATSAPP_VERIFY_TOKEN` | Meta | **Ya** | Token verifikasi webhook WhatsApp; juga fallback terakhir token Meta/Threads. |
| `WHATSAPP_EMBEDDED_CONFIG_ID` | Meta | Tidak | Configuration ID Embedded Signup (bagian 5); tombol Connect WhatsApp hanya muncul bila terisi. |
| `WHATSAPP_ACCESS_TOKEN` | Meta | **Ya** | Fallback env untuk akun WhatsApp tanpa token vault; pemakaian normal memakai token per-akun dari Embedded Signup. |
| `MESSENGER_ACCESS_TOKEN` | Meta | **Ya** | Fallback env untuk akun Messenger tanpa token vault. |
| `INSTAGRAM_APP_ID` | Instagram | Tidak | Untuk mode Instagram Login; kosong = fallback ke `META_APP_ID`. |
| `INSTAGRAM_APP_SECRET` | Instagram | **Ya** | Untuk mode Instagram Login; kosong = fallback ke `META_APP_SECRET`. |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram | **Ya** | Fallback env untuk akun Instagram tanpa token vault. |
| `THREADS_APP_ID` | Threads | Tidak | App ID app Threads terpisah. |
| `THREADS_APP_SECRET` | Threads | **Ya** | App Secret app Threads. **Wajib diisi sendiri**: callback OAuth Threads tidak memakai fallback `META_APP_SECRET` (fallback hanya berlaku untuk verifikasi tanda tangan webhook). |
| `THREADS_VERIFY_TOKEN` | Threads | **Ya** | Token verifikasi webhook Threads; kosong = fallback ke rantai Meta. |
| `THREADS_ACCESS_TOKEN` | Threads | **Ya** | Fallback env untuk akun Threads tanpa token vault. |

**Token verifikasi** adalah string pilihan operator sendiri (buat satu
nilai acak yang kuat, mis. `<TOKEN_VERIFIKASI>`). Nilai yang sama harus
ditempel persis — tanpa spasi tambahan — ke konfigurasi webhook setiap
produk Meta. Anda boleh memakai satu nilai yang sama untuk
`META_VERIFY_TOKEN` dan `WHATSAPP_VERIFY_TOKEN` (paling sederhana dan
disarankan); untuk app Threads, nilai yang ditempel di sana harus sama
dengan hasil resolusi rantainya — dengan satu nilai bersama, cukup
tempel nilai yang sama.

Yang **tidak** bisa diatur dari panel (env saja, memang disengaja):
`SESSION_SECRET` (penanda tangan sesi/OAuth state — harus bekerja
sebelum DB dibaca), `TOKEN_VAULT_KEY` (kunci yang mengenkripsi
pengaturan itu sendiri), `DATABASE_URL` dan `REDIS_URL` (koordinat
untuk mencapai DB/cache). Mengubahnya berarti mengedit environment dan
me-restart layanan terkait.

---

## 4. Langkah bersama: Facebook Login — Valid OAuth Redirect URIs

Untuk app utama, buka produk **Facebook Login → Settings** dan tambahkan
**persis** URL berikut ke **Valid OAuth Redirect URIs** (satu per baris,
tanpa trailing slash tambahan):

```
https://dev.botara.my.id/api/channels/messenger/oauth/callback
https://dev.botara.my.id/api/channels/instagram/oauth/callback
```

Untuk mode **Instagram Login** (Business Login for Instagram), produk
Instagram punya daftar redirect URI-nya sendiri — tambahkan URL
callback Instagram yang sama di sana.

Untuk **app Threads**, tambahkan di pengaturan OAuth/Threads API app
Threads:

```
https://dev.botara.my.id/api/channels/threads/oauth/callback
```

WhatsApp **tidak** memakai redirect URI — koneksinya melalui popup
Embedded Signup (bagian 5).

Setelah pengguna menyelesaikan login, Botara menukar kode otorisasi,
menyimpan token ke vault terenkripsi, membuat akun kanal, lalu
mengembalikan browser ke halaman Channels Botara. Jika admin mengelola
lebih dari satu Page saat connect Messenger, Botara menampilkan pemilih
Page di halaman Channels untuk memilih Page yang benar.

---

## 5. WhatsApp

### 5.1 Webhook

Di app utama → produk **WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://dev.botara.my.id/api/webhooks/whatsapp`
- **Verify token**: nilai `WHATSAPP_VERIFY_TOKEN` Anda.
- Klik **Verify and save**.

Lalu di tingkat WABA (**Manage** pada daftar webhook fields), langgankan
field berikut — field inilah yang diproses kode Botara:

| Field | Dipakai untuk |
|---|---|
| `messages` | Pesan masuk, status kirim, dan echo dari nomor yang sama. **Wajib.** |
| `template_category_update` | Perubahan kategori template diterapkan ke data template Botara. |
| `smb_message_echoes` | Coexistence: pesan yang dikirim dari aplikasi WhatsApp Business tampil sebagai pesan keluar di inbox. |
| `smb_app_state_sync` | Coexistence: sinkronisasi kontak dari aplikasi WhatsApp Business. |
| `history` | Coexistence: backfill riwayat chat dengan timestamp asli. |

Tiga field coexistence aman dilanggankan untuk semua WABA; untuk nomor
non-coexistence field itu tidak mengirim apa-apa. Setelah Embedded
Signup menghubungkan sebuah WABA, konfigurasi webhook tingkat app inilah
yang mengantarkan event-nya — tidak ada langkah `subscribed_apps` manual
untuk alur signup normal (Meta melanggankan app ke WABA selama alur
signup).

### 5.2 Embedded Signup (koneksi nomor sungguhan)

1. Di produk WhatsApp → **Embedded Signup**, buat sebuah **Signup
   configuration** (v4; v2/v3 sudah pensiun). Catat **Configuration
   ID**-nya — ini identifier, bukan rahasia.
2. Masukkan ke Panel Admin → Settings → grup Meta →
   `WHATSAPP_EMBEDDED_CONFIG_ID` (atau env). Pastikan juga `META_APP_ID`
   terisi.
3. Tombol **Connect WhatsApp** di halaman Channels Botara hanya muncul
   bila config ID terisi. Klik tombol itu: popup Facebook Login terbuka
   dengan config ID tersebut, pengguna memilih/membuat WABA dan nomor,
   lalu Botara menukar kode hasil signup di
   `POST /api/channels/whatsapp/embedded-signup/exchange`, menyimpan
   token hasil onboarding ke vault, dan membuat akun kanal berstatus
   connected.
4. Nomor **coexistence** (nomor yang juga dipakai di aplikasi WhatsApp
   Business) terdeteksi otomatis saat signup; Botara meminta sinkronisasi
   kontak + riwayat (`smb_app_data`) dan menandainya dengan badge
   coexistence di halaman Channels.

### 5.3 Nomor uji WhatsApp (test number)

Dashboard WhatsApp → **API Setup** memberi setiap app sebuah **nomor uji
bersama** (default yang dikenal: +1 (555) 651-4110) beserta **token
sementara 24 jam** dari tombol pembuatan token. Nomor uji **tidak bisa**
dionboard lewat Embedded Signup (tidak ada sesi signup untuknya), jadi
Botara menyediakan skrip provisioning yang menulis persis apa yang
ditulis signup yang berhasil:

```bash
# Di server, dari root repo — wrapper menyiapkan DATABASE_URL +
# TOKEN_VAULT_KEY dari .env dan meminta token dengan input tersembunyi:
~/provision-wa-test.sh
```

Skrip dasarnya `scripts/provision-wa-test-number.ts` dengan env:

| Env | Wajib? | Keterangan |
|---|---|---|
| `WORKSPACE_ID` | Ya | UUID workspace tujuan. |
| `WA_TEST_TOKEN` | Ya | Token sementara dari dashboard; tidak pernah dicetak skrip. |
| `WA_PHONE_NUMBER_ID` | Tidak | Default `1361611993704410` (nomor uji Meta). |
| `WA_WABA_ID` | Tidak | Default `2227032434830165` (WABA uji). |
| `WA_DISPLAY_NAME` | Tidak | Default "Nomor Uji Meta". |
| `META_GRAPH_VERSION` | Tidak | Default `v26.0`. |

Perilaku skrip: token disimpan ke vault terenkripsi (label
`waba:{wabaId}`), satu baris akun kanal dibuat bila belum ada, dan skrip
mencoba `POST /{wabaId}/subscribed_apps` secara best-effort (kegagalan
dilaporkan, tidak menggagalkan provisioning). **Idempoten**: jalankan
ulang dengan token baru untuk memutar token yang kedaluwarsa setelah
24 jam.

Batasan WABA uji dari sisi Meta: nomor uji hanya bisa **mengirim** ke
maksimal **5 nomor penerima yang terverifikasi**. Tambahkan nomor
pribadi Anda di daftar penerima pada halaman API Setup dan verifikasi
kode yang dikirim Meta ke WhatsApp Anda **sebelum** menguji kaki
balasan; pesan masuk dari ponsel Anda ke nomor uji tetap tiba tanpa itu.

---

## 6. Messenger

Koneksi Messenger adalah koneksi **Page**: pengguna login dengan
Facebook, memilih Page, dan token Page disimpan ke vault.

### 6.1 Webhook

Di app utama → produk **Messenger → Settings → Webhooks**:

- **Callback URL**: `https://dev.botara.my.id/api/webhooks/messenger`
- **Verify token**: nilai `META_VERIFY_TOKEN` Anda (Botara memeriksa
  `META_VERIFY_TOKEN`, fallback `WHATSAPP_VERIFY_TOKEN`).
- Klik **Verify and save**.

> **Kolom ini yang paling sering salah isi.** Kolom Callback URL
> webhook diisi URL **webhook** di atas. URL
> `.../api/channels/messenger/oauth/callback` adalah URL **OAuth** —
> tempatnya di Facebook Login → Valid OAuth Redirect URIs (bagian 4),
> bukan di sini. Tertukar = error "URL callback atau token verifikasi
> tidak dapat divalidasi" (lihat 12a).

Langganan field di tingkat **Page** (kode Botara memproses event
`entry.messaging`):

| Field | Dipakai untuk |
|---|---|
| `messages` | Pesan masuk/keluar Page. **Wajib.** |
| `messaging_postbacks` | Klik tombol/postback pada pesan. |
| `message_deliveries` | Konfirmasi pengiriman pesan. |

### 6.2 Koneksi

Pastikan URL callback Messenger sudah ada di Valid OAuth Redirect URIs
(bagian 4), lalu dari Botara → **Channels → Connect Messenger**. Dalam
mode Development, hanya pengguna berperan di app (Admin/Developer/
Tester) yang bisa menyelesaikan koneksi dan bertukar pesan — lihat
bagian 11.

---

## 7. Instagram

Botara mendukung **dua mode login** Instagram; fitur sama, kredensial
dan halaman konfigurasinya berbeda:

| Mode | Kredensial yang dipakai | Kapan dipakai |
|---|---|---|
| **Facebook Login** | `META_APP_ID` / `META_APP_SECRET` | Akun Instagram profesional yang tertaut ke Facebook Page. |
| **Instagram Login** | `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` (fallback ke pasangan Meta bila kosong) | Login langsung dengan kredensial Instagram, tanpa Page. |

### 7.1 Webhook

Satu URL untuk kedua mode, dikonfigurasi di produk Instagram / langganan
webhook Page:

- **Callback URL**: `https://dev.botara.my.id/api/webhooks/instagram`
- **Verify token**: nilai `META_VERIFY_TOKEN` Anda (rantai fallback
  sama seperti Messenger).

Langganan field yang diproses kode Botara:

| Field | Dipakai untuk |
|---|---|
| `messages` | DM masuk ke akun profesional (tiba sebagai `entry.messaging`). **Wajib untuk inbox.** |
| `comments` | Komentar pada postingan bisnis (moderasi + comment-to-DM). |
| `mentions` | Postingan yang me-mention akun bisnis. |

### 7.2 Koneksi

Tambahkan URL callback Instagram ke Valid OAuth Redirect URIs —
di Facebook Login untuk mode Facebook Login, dan di daftar redirect
produk Instagram untuk mode Instagram Login (bagian 4). Lalu dari
Botara → **Channels → Connect Instagram** dan pilih mode yang sesuai.
Pada mode Facebook Login, Botara memilih Page yang memiliki akun
Instagram bisnis tertaut; bila tidak ada, koneksi gagal dengan alasan
yang ditampilkan di halaman Channels.

---

## 8. Threads (app terpisah)

Semua langkah di bagian ini dilakukan di **app Threads**, bukan app
utama — termasuk konfigurasi webhook dan OAuth-nya.

1. Isi Panel Admin → Settings → grup Threads: `THREADS_APP_ID` dan
   `THREADS_APP_SECRET` (keduanya wajib untuk connect OAuth; lihat
   catatan fallback di bagian 3), dan `THREADS_VERIFY_TOKEN` bila ingin
   token khusus Threads.
2. **Webhook** (pengaturan Threads API di app Threads):
   - **Callback URL**: `https://dev.botara.my.id/api/webhooks/threads`
   - **Verify token**: nilai yang sama dengan resolusi rantai Botara —
     `THREADS_VERIFY_TOKEN` bila diisi, selain itu `META_VERIFY_TOKEN`
     Anda.
   - Langganan field yang diproses kode Botara: **`replies`** (balasan
     pada postingan bisnis masuk sebagai komentar) dan **`mentions`**
     (postingan yang me-mention profil bisnis).
3. **OAuth**: tambahkan
   `https://dev.botara.my.id/api/channels/threads/oauth/callback`
   sebagai redirect URI di app Threads (bagian 4), lalu connect dari
   Botara → **Channels → Connect Threads**. Token long-lived hasil
   tukar disimpan di vault dan di-refresh worker pada siklus 60 hari.
4. Ingat batas produknya: Threads **tidak punya API DM dan tidak punya
   API like** — Botara tidak meminta dan tidak mensimulasikannya.
   Otomasi Threads di Botara adalah publishing, replies, mentions,
   keyword listening, dan insights (lihat `docs/app-review/permissions.md`).

---

## 9. Penghapusan data (data deletion)

Meta **mewajibkan** callback ini untuk persetujuan app. Botara sudah
mengimplementasikannya; tugas operator hanya mendaftarkan URL-nya:

- **URL callback** (Settings → Basic → Data Deletion Request URL, app
  utama): `https://dev.botara.my.id/api/webhooks/meta/data-deletion`
- **URL yang sama didaftarkan di ketiga aplikasi**: app Instagram Login
  (developers.facebook.com → app Instagram Login → Settings →
  Advanced) dan app Threads (developers.threads.net → Settings →
  Advanced) memakai URL callback yang persis sama — satu endpoint
  melayani Meta + Instagram Login + Threads.
- Perilaku endpoint: menerima POST berisi `signed_request`, memverifikasi
  HMAC-nya terhadap secret aplikasi pengirim — `META_APP_SECRET`,
  `INSTAGRAM_APP_SECRET`, atau `THREADS_APP_SECRET` (secret per-app
  fallback ke `META_APP_SECRET`; bila tidak ada satu pun yang
  terkonfigurasi endpoint menjawab 503 — isi secret-nya), mencatat
  permintaan, menghapus data kontak pengguna provider terkait secara
  best-effort, dan membalas `{ url, confirmation_code }`.
- **Halaman status publik** untuk pengguna:
  `https://dev.botara.my.id/api/data-deletion/status/<confirmation_code>`
- Di field **Data deletion instructions URL** pada formulir App Review,
  isi `https://dev.botara.my.id/privacy`.

---

## 10. App Review (ringkasan — paket lengkap di `docs/app-review/`)

Panduan ini tidak mengulang paket App Review. Yang perlu operator tahu:

- **Daftar izin yang diajukan sudah final** di
  `docs/app-review/permissions.md`, lengkap dengan teks justifikasi
  siap tempel per izin (WhatsApp `whatsapp_business_messaging` +
  `whatsapp_business_management`; Instagram kedua mode login; Messenger
  `pages_messaging` dkk.; Threads di app terpisah). **Jangan meminta
  izin di luar daftar itu** — app tidak boleh meminta apa pun yang tidak
  dipakai produk.
- **Screencast per kelompok izin** mengikuti naskah shot-by-shot di
  `docs/app-review/screencast-scripts.md` (W1–W2, I1–I4 per mode login,
  M1, T1–T5), direkam dari akun uji dengan UI berbahasa Inggris (default
  Botara).
- **Urutan dan siapa mengerjakan apa** ada di
  `docs/app-review/submission-checklist.md` — langkah bertanda
  **[OWNER]** (verifikasi bisnis, identitas, pengajuan) hanya bisa
  dilakukan pemilik akun; langkah **[PREPARED]** sudah disiapkan repo.
- Prasyarat yang paling sering menunda: **verifikasi bisnis** (mulai
  paling awal), halaman `/privacy` + `/terms` yang sudah difinalkan,
  semua webhook terverifikasi (bagian 5–9), dan akun Botara khusus
  review dengan kanal uji sudah terhubung untuk peninjau.
- Selama peninjauan, pantau pesan App Review setiap hari — peninjau
  lazimnya meminta login uji yang berfungsi atau rekaman ulang, dengan
  tenggat.

---

## 11. Mode Development → Live

- Selama app berstatus **Development**, hanya orang yang punya peran di
  app (Admin, Developer, Tester) yang bisa login OAuth, terhubung, dan
  bertukar pesan lewat app. Pengguna publik **tidak bisa** — ini
  perilaku Meta, bukan kerusakan Botara.
- Setelah App Review disetujui, alihkan app ke mode **Live** (app utama
  dan app Threads masing-masing).
- Setelah Live: hubungkan ulang kanal produksi dari halaman Channels
  (token era Development terbatas), lalu jalankan uji ujung-ke-ujung
  per kanal: kirim pesan masuk → muncul di Inbox → balas → diterima di
  aplikasi kanal.

---

## 12. Troubleshooting

### 12a. "URL callback atau token verifikasi tidak dapat divalidasi"

Error ini muncul saat menyimpan konfigurasi webhook (paling sering di
Messenger) dan hampir selalu berarti satu dari tiga hal:

1. **URL yang ditempel adalah URL OAuth, bukan URL webhook.** Perbaiki
   field per field:
   - Kolom **Callback URL** pada konfigurasi **Webhook** produk ←
     `https://dev.botara.my.id/api/webhooks/messenger`
     (atau `/webhooks/<kanal>` sesuai produk).
   - Kolom **Verify token** pada konfigurasi yang sama ← nilai
     `META_VERIFY_TOKEN` Anda, persis.
   - URL `https://dev.botara.my.id/api/channels/messenger/oauth/callback`
     ← pindahkan ke **Facebook Login → Settings → Valid OAuth Redirect
     URIs**. URL itu benar — hanya salah kolom.
2. **Token verifikasi tidak sama persis** dengan yang dikonfigurasi di
   Botara (beda satu karakter, ada spasi di ujung, atau nilai lama).
   Samakan dengan Panel Admin → Settings (grup Meta), simpan, coba lagi.
3. **URL tidak terjangkau Meta**: domain/tunnel mati, HTTPS tidak valid,
   atau `PUBLIC_WEBHOOK_BASE_URL` tidak diakhiri `/api` sehingga URL
   yang ditempel tidak mengarah ke API. Uji dari luar:
   membuka URL webhook di browser harus menghasilkan jawaban Botara
   (bukan 404 dari situs lain).

### 12b. Verifikasi webhook ditolak / 403

Token yang dikirim Meta tidak cocok dengan token hasil resolusi Botara
untuk kanal itu. Ingat rantainya: WhatsApp hanya memeriksa
`WHATSAPP_VERIFY_TOKEN` (**tidak** ada fallback ke `META_VERIFY_TOKEN` —
mengisi token Meta saja tidak cukup untuk WhatsApp); Messenger/Instagram
memeriksa `META_VERIFY_TOKEN` lalu `WHATSAPP_VERIFY_TOKEN`; Threads
memeriksa `THREADS_VERIFY_TOKEN` lalu rantai Meta. Periksa nilai efektif
di Panel Admin (DB menang atas env — nilai env lama bisa tertimpa nilai
panel).

### 12c. POST webhook ditolak 401 "Invalid X-Hub-Signature-256"

App Secret yang memverifikasi tidak sama dengan App Secret app yang
mengirim event: biasanya tertukar antar app (event Threads diverifikasi
dengan `THREADS_APP_SECRET`, fallback `META_APP_SECRET`; kanal lain
dengan `META_APP_SECRET`), atau secret baru saja dirotasi di dashboard
tetapi belum diperbarui di panel. Samakan, lalu tunggu ±1 menit untuk
propagasi.

### 12d. Tombol Connect WhatsApp tidak muncul

`WHATSAPP_EMBEDDED_CONFIG_ID` belum terisi (atau `META_APP_ID` kosong).
Cek cepat: `GET https://dev.botara.my.id/api/config/public` harus
menampilkan `whatsappEmbeddedConfigId` (dan `metaAppId`) tidak null.
Isi dari Panel Admin → Settings → grup Meta.

### 12e. Tombol/koneksi OAuth kanal lain gagal dengan alasan konfigurasi

- **Threads**: `THREADS_APP_ID`/`THREADS_APP_SECRET` belum diisi —
  callback OAuth Threads **tidak** memakai fallback `META_APP_SECRET`.
- **Instagram mode Instagram Login**: pasangan Instagram kosong **dan**
  fallback Meta kosong.
- **Messenger**: `META_APP_ID`/`META_APP_SECRET` belum terisi.
Isi dari panel, lalu coba lagi; halaman Channels menampilkan alasan
kegagalan dari callback.

### 12f. Nomor uji WhatsApp tidak bisa mengirim ke nomor saya

Nomor tujuan belum menjadi **penerima terverifikasi** di WABA uji
(maksimal 5). Tambahkan nomor di halaman WhatsApp → API Setup dan
selesaikan verifikasi kode dari Meta. Alternatif lain: token sementara
sudah lewat 24 jam — klik tombol buat token lagi, lalu jalankan ulang
`~/provision-wa-test.sh` (idempoten; token dirotasi).

### 12g. Orang lain tidak bisa terhubung / pesan dari publik tidak masuk

App masih mode **Development** — hanya pengguna berperan di app yang
bisa berinteraksi. Selesaikan App Review (bagian 10) lalu alihkan ke
**Live** (bagian 11). Berlaku per app: app Threads punya mode sendiri.

### 12h. Callback penghapusan data gagal / 503

Belum ada app secret yang dikonfigurasi di deployment
(`META_APP_SECRET` / `INSTAGRAM_APP_SECRET` / `THREADS_APP_SECRET`) —
endpoint penghapusan data menolak memproses `signed_request` tanpa
secret. Isi dari Panel Admin → Settings.

### 12i. Pesan masuk tidak tiba padahal webhook terverifikasi

Periksa **langganan field**: WhatsApp butuh `messages` di tingkat WABA;
Messenger butuh `messages` di tingkat Page; Instagram butuh `messages`;
Threads butuh `replies`/`mentions`. Webhook yang terverifikasi tetapi
field-nya tidak dilanggankan tidak mengirim event apa pun. Untuk
WhatsApp hasil Embedded Signup, pastikan juga WABA yang benar yang
terhubung (skenario banyak-WABA).

---

## 13. Checklist status akhir

Konfigurasi dianggap selesai bila semua kotak tercentang:

**Aplikasi & kredensial**

- [ ] App Meta utama dibuat (WhatsApp + Messenger + Instagram + Pages)
      dan App ID tercatat.
- [ ] App Threads terpisah dibuat dan App ID tercatat.
- [ ] Bisnis terverifikasi di Business Settings.
- [ ] Settings → Basic app utama lengkap: App Domains, Website URL,
      Privacy Policy URL, Terms URL, Data Deletion Request URL.
- [ ] `META_APP_ID` + `META_APP_SECRET` terisi (Panel Admin → Settings).
- [ ] `THREADS_APP_ID` + `THREADS_APP_SECRET` terisi.
- [ ] `META_VERIFY_TOKEN` + `WHATSAPP_VERIFY_TOKEN` terisi dan nilainya
      sama dengan yang ditempel di semua konfigurasi webhook.
- [ ] `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` terisi bila memakai mode
      Instagram Login.
- [ ] Halaman `/privacy` dan `/terms` sudah difinalkan (bukan template).

**Webhook (Verify and save berhasil untuk semuanya)**

- [ ] WhatsApp: `.../api/webhooks/whatsapp` + field `messages`,
      `template_category_update`, dan field coexistence
      (`smb_message_echoes`, `smb_app_state_sync`, `history`).
- [ ] Messenger: `.../api/webhooks/messenger` + field Page `messages`,
      `messaging_postbacks`, `message_deliveries`.
- [ ] Instagram: `.../api/webhooks/instagram` + field `messages`,
      `comments`, `mentions`.
- [ ] Threads: `.../api/webhooks/threads` + field `replies`, `mentions`.
- [ ] Penghapusan data terdaftar:
      `.../api/webhooks/meta/data-deletion`.

**Koneksi kanal**

- [ ] Valid OAuth Redirect URIs berisi callback Messenger + Instagram
      (Facebook Login), callback Instagram (produk Instagram, mode
      Instagram Login), dan callback Threads (app Threads).
- [ ] `WHATSAPP_EMBEDDED_CONFIG_ID` terisi; tombol Connect WhatsApp
      muncul di Channels; satu nomor sungguhan terhubung dan teruji
      dua arah.
- [ ] (Opsional, untuk pengujian awal) Nomor uji terprovisioning via
      `~/provision-wa-test.sh` dan nomor pribadi terverifikasi sebagai
      penerima di WABA uji.
- [ ] Page Messenger terhubung dan teruji dua arah dari Inbox.
- [ ] Instagram terhubung (mode yang dipilih) dan DM teruji dua arah.
- [ ] Threads terhubung; replies/mentions uji muncul di Botara.

**App Review & Live**

- [ ] Screencast direkam mengikuti `docs/app-review/screencast-scripts.md`.
- [ ] Justifikasi izin ditempel dari `docs/app-review/permissions.md`;
      tidak ada izin di luar daftar itu.
- [ ] App Review diajukan untuk app utama dan app Threads.
- [ ] Setelah disetujui: kedua app dialihkan ke **Live**, kanal produksi
      dihubungkan ulang, dan uji ujung-ke-ujung per kanal diulang.
