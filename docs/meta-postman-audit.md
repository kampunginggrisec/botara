# Audit Kesesuaian Botara ↔ Koleksi Postman Meta

**Tanggal:** 2026-10-27
**Sumber acuan:** `E:\PROJECTS\Meta-doc-postman-collection` (11 koleksi resmi Meta, 521 request, 226 endpoint unik)
**Yang diaudit:** `packages/channels/src/*` (adapter), `apps/api/src/whatsapp-onboarding.ts`, `apps/api/src/catalog-sync.ts`, `apps/api/src/app.ts` (webhook + route kanal), `scripts/*`

---

## 1. Kesimpulan (verdict)

**Untuk jalur produksi yang dipakai produk (kirim/terima pesan, template send, media, komentar, publish, onboarding), implementasi sudah SESUAI dengan kontrak Meta** — termasuk beberapa hal yang justru **belum ada di koleksi** (Marketing Messages API, coexistence `smb_app_data`, dual-login Instagram).

**Yang belum sesuai ada di lapisan manajemen aset**, bukan lapisan messaging:

| Area | Kondisi |
|---|---|
| Runtime messaging (WA/Messenger/IG/Threads) | ✅ sesuai, ter-mock-test |
| Onboarding (Embedded Signup, OAuth 3 kanal) | ✅ sesuai (ES-1 sudah diperbaiki) |
| Manajemen template WhatsApp | ⚠️ **sync pull** sudah ada (status approval + kategori dari Meta); create/edit/delete dari panel belum |
| Manajemen nomor/profil/QR/block/commerce | ❌ tidak ada (sebagian memang di luar cakupan produk) |
| WhatsApp Flows API | ❌ tidak ada — dan **konsep "flows" Botara berbeda** (automation engine sendiri, bukan WA Flows) |
| WhatsApp Ads / Marketing API (3 koleksi) | ❌ tidak ada — di luar cakupan produk |

Skor kasar: **≈ 45% endpoint unik sudah dipakai (naik dari ≈40% setelah gelombang 2), ≈ 25% sengaja di luar cakupan, sisanya gap yang sebagian layak dikerjakan** (lihat §11).

---

## 2. Metode

1. Ekstraksi `method + path` unik dari setiap koleksi (varian payload dihitung satu, `{{var}}` dinormalisasi).
2. Penelusuran balik ke kode: setiap panggilan Graph API di repo dicocokkan ke endpoint koleksi.
3. Klasifikasi: **Sesuai** (dipanggil dengan bentuk yang benar) · **Sebagian** (hanya subset field/operasi) · **Belum ada** (gap nyata) · **Di luar cakupan** (sengaja tidak dikerjakan).
4. Verifikasi perilaku: `bun test packages apps` (§13).

Angka cakupan:

| Koleksi | Request | Endpoint unik |
|---|---|---|
| WhatsApp Cloud API | 162 | 48 |
| WhatsApp Business Management `[MOVED]` | 41 | 21 |
| WhatsApp Flows `[MOVED]` | 29 | 17 |
| Messenger Platform API | 54 | 17 |
| Instagram API | 58 | 21 |
| Threads API | 39 | 28 |
| Embedded Signup | 29 | 17 |
| Facebook API | 7 | 4 |
| MAPI / MAPI-GenAI / MAPI-Onboarding | 46 / 35 / 21 | 29 / 12 / 12 |
| **Total** | **521** | **226** |

> Dua file berlabel `[MOVED]` adalah koleksi lama yang isinya sudah diserap ke WhatsApp Cloud API (Business Management) dan tetap terpisah hanya untuk Flows. Tidak dihitung ganda di matriks.

---

## 3. Matriks per koleksi

| Koleksi | Sesuai | Sebagian | Belum ada | Di luar cakupan | Catatan |
|---|---|---|---|---|---|
| WhatsApp Cloud API | 9 | 1 | 19 | 19 | inti messaging aman; gap di manajemen nomor (template sudah ditutup di §11.0) |
| Embedded Signup | 5 | 1 | 11 | 0 | jalur wajib (code→token→WABA→nomor→subscribe) lengkap |
| Messenger Platform | 6 | 1 | 10 | 0 | kurang attachment upload & Conversations API (sender actions, profile sudah ditutup) |
| Instagram API | 8 | 1 | 12 | 0 | kurang Conversations API (welcome flows & persistent menu sudah ditutup) |
| Threads API | 12 | 1 | 15 | 0 | kurang carousel, repost, read replies, location |
| Facebook API (Page) | 2 | 0 | 2 | 0 | Reels Page belum ada |
| MAPI + GenAI + Onboarding | 0 | 0 | 0 | 53 | produk ini bukan ad manager |

> Angka di tabel ini adalah **snapshot audit awal**. Kemajuan setelahnya
> dilacak di §11.0 (per temuan) dan di tabel endpoint per kanal (§4–§10),
> yang keduanya diperbarui. Kolom di sini sengaja tidak dihitung ulang:
> menggeser angka tanpa inventarisasi ulang seluruh koleksi akan menghasilkan
> presisi palsu.

---

## 4. Detail — WhatsApp Cloud API

Legenda lokasi: `wa` = `packages/channels/src/whatsapp.ts`, `onb` = `apps/api/src/whatsapp-onboarding.ts`, `cat` = `apps/api/src/catalog-sync.ts`.

### 4.1 Pesan & media

| Endpoint | Status | Lokasi |
|---|---|---|
| `POST /{phone}/messages` (text, image/video/document/audio/sticker, template, interactive button/list/cta_url/product/product_list) | ✅ | `wa:230`, `wa:289` |
| `POST /{phone}/marketing_messages` (routing per kategori template) | ✅ **(di luar koleksi)** | `wa:37`, `wa:271` |
| `POST /{phone}/media` (upload) | ✅ | `wa:409` |
| `GET /{media-id}` (resolve URL unduh) | ✅ | `wa:438` |
| `DELETE /{media-id}` | ❌ | — (media Meta auto-expire 30 hari, dampak rendah) |
| `PUT /{phone}/messages` (mark as read) | ✅ | `wa:markRead` → route `POST /conversations/{id}/read` |
| `typing_indicator` | ✅ | `wa:typing` → route `POST /conversations/{id}/typing` |

**Varian "Send Reply to …" (12 request di koleksi) sekarang didukung**: `SendInput.replyToExternalId` mengisi `context.message_id`, dan inbox mengirimkannya lewat `replyToMessageId`. Yang **masih** tidak bisa dikirim: `reaction`, `location`, dan `contacts` (semuanya tetap diparse saat inbound).

### 4.2 Template

| Endpoint | Status |
|---|---|
| `GET /{waba}/message_templates` | ✅ (sync pull, `template-sync.ts`) |
| `POST /{waba}/message_templates` (buat) | ✅ `POST /templates/submit` → `createMessageTemplate` + validator komponen (`template-write.ts`) |
| `DELETE /{waba}/message_templates` | ✅ `DELETE /templates/{id}` (hapus di Meta dulu, lalu baris lokal) |
| `GET /{template-id}` | ❌ (tidak perlu: sync sudah membawa status/kategori/komponen/alasan penolakan) |
| `POST /{template-id}` (edit) | ❌ sengaja tidak ada — Meta mem-version-kan template; perubahan = submit ulang |

Tabel `templates` di DB adalah **mirror** dari Meta. `POST /templates/sync` menarik `GET /{waba}/message_templates` (paging berbatas) dan meng-upsert per (akun, nama, bahasa) sehingga `status` approval, `category`, `components`, dan `rejected_reason` berasal dari Meta, bukan dari form. Arah sebaliknya lewat `POST /templates/submit`: komponen divalidasi dengan aturan Meta lebih dulu (satu BODY, `{{n}}` berurutan, plafon tombol, header media wajib contoh), lalu status yang dicerminkan adalah **jawaban** Meta — biasanya `pending`, bukan `approved`. Baris `templates.components` menyimpan pohon komponen itu, dan `POST /broadcasts` memakainya untuk menolak jumlah parameter yang tidak cocok sebelum fan-out diantrikan.

### 4.3 Nomor, WABA, subscription

| Endpoint | Status | Lokasi |
|---|---|---|
| `GET /{waba}/phone_numbers` | ✅ | `onb:251` |
| `POST /{waba}/subscribed_apps` | ✅ | `onb:322` (ES-1) |
| `GET /{waba}/subscribed_apps` | ❌ | tidak bisa memverifikasi status langganan dari panel |
| `DELETE /{waba}/subscribed_apps` | ❌ | — |
| `GET /{phone}?fields=whatsapp_business_account` | ✅ | `cat:149` |
| `GET /{waba}/owned_product_catalogs` | ✅ | `cat:169` |
| `GET /{catalog}/products` | ✅ | `cat:189` |
| `POST /{phone}/register` · `deregister` | ❌ | — |
| `POST /{phone}/request_code` · `verify_code` | ❌ | — |
| `POST /{phone}` (two-step verification) | ❌ | — |
| `GET /{waba}`, `owned_*`, `client_whatsapp_business_accounts` | ❌ | WABA id hanya dari `debug_token`/session info |
| `GET /debug_token` | ✅ | `onb:227` |

### 4.4 Profil bisnis, QR, commerce, block, analytics, billing

| Endpoint | Status | Catatan |
|---|---|---|
| `GET /{phone}/whatsapp_business_profile` | ⚠️ sebagian | hanya `fields=profile_picture_url` (`onb:275`) |
| `POST /{phone}/whatsapp_business_profile` | ❌ | about/address/vertical/email/websites tidak bisa diatur dari panel |
| `message_qrdls` (CRUD, 5 request) | ❌ | Botara punya QR sendiri (SVG server-side) untuk growth link — **bukan** QR Meta |
| `whatsapp_commerce_settings` (2) | ❌ | — |
| `block_users` (3) | ❌ | — |
| `analytics` (2) · `extendedcredits` (1) · `business_compliance_info` (2) | ❌ | biaya dihitung dari rate-card sendiri (`ADR-008`), bukan dari Meta |
| `app/uploads` (resumable upload) | ❌ | upload media pakai multipart biasa, cukup untuk ≤ 100 MB |
| `Payments API SG/IN` (4) · `OnPrem migration` (1) | ❌ | di luar cakupan |

### 4.5 Webhook (22 referensi payload)

Sudah ditangani: `messages` (text, media, button/interactive→postback), `statuses`, `referral` (ctwa), `template_category_update`, `smb_message_echoes`, `smb_app_state_sync`, `history`. Signature `X-Hub-Signature-256` diverifikasi atas **raw body** (`wa:88`), GET verification `hub.challenge` benar (`wa:101`). Tidak ada payload referensi yang terlewat secara struktural.

### 4.6 WhatsApp Flows API

17 endpoint (`flows` CRUD, `assets`, `publish`, `deprecate`, `migrate_flows`, `whatsapp_business_encryption`, endpoint metrics) **tidak diimplementasikan**. Penting dicatat: **"flows" di Botara adalah automation engine internal** (`packages/flow-engine`), bukan WhatsApp Flows. Balasan `nfm_reply` dari WA Flow masuk sebagai `message.received` biasa (tidak diparse khusus). Ini bukan bug, tapi mudah disalahpahami saat presentasi.

---

## 5. Detail — Embedded Signup

Jalur wajib sudah utuh: `oauth/access_token` → `debug_token` (granular scopes) → `phone_numbers` → vault → `subscribed_apps` → `smb_app_data` (coexistence). Lihat `onb:178-370`.

| Endpoint | Status |
|---|---|
| `GET /oauth/access_token`, `GET /debug_token`, `GET /{waba}/phone_numbers` | ✅ |
| `POST /{waba}/subscribed_apps` | ✅ (best-effort, hasil dilaporkan) |
| `POST /{phone}/smb_app_data` (contacts + history) | ✅ (di luar koleksi) |
| `GET/POST /{waba}/assigned_users` | ❌ — hanya relevan bila Botara jadi Tech Provider dengan system user |
| `GET /{biz}/system_users` | ❌ |
| `GET /{waba}/message_templates` saat onboarding | ❌ — namespace template tidak diambil |
| `GET/DELETE /{waba}/subscribed_apps` | ❌ — tidak ada verifikasi pasca-onboarding |
| `extendedcredits` / credit sharing (3) | ❌ — hanya relevan untuk model agensi/LOA |
| `GET /{biz}/owned_*` / `client_*` WABA | ❌ |

---

## 6. Detail — Messenger Platform API

| Endpoint | Status | Lokasi |
|---|---|---|
| `POST /me/messages` (text, attachment URL, button template, generic template, quick replies) | ✅ | `messenger.ts:230`, `:271` |
| `POST /me/messages` + `recipient.comment_id` (private reply) | ✅ | `:355` |
| `POST /me/pass_thread_control` · `me/take_thread_control` | ✅ | `:371`, `:384` |
| `POST /me/messenger_profile` (get_started, persistent_menu) | ✅ | `:398`, `:405` |
| `POST /{page}/feed` (publish) | ✅ | `:422` |
| `POST /{comment-id}` hide/unhide, `DELETE`, `/{comment-id}/comments` | ✅ | `:435` |
| `GET /{page}/insights` | ✅ | `:460` — `page_views_total,page_post_engagements` (P2-1) |
| Sender actions (`typing_on`, `mark_seen`) | ✅ | `markRead`/`typing` via `me/messages` sender_action |
| `POST /{page}/message_attachments` (attachment upload) | ❌ | media wajib public URL |
| `GET /me/messenger_profile` · `DELETE` | ❌ | menu hanya bisa di-set, tidak dibaca/dihapus |
| `greeting`, `ice_breakers`, `whitelisted_domains`, `account_linking`, `custom_user_settings` | ❌ | — |
| `GET /{conv-id}/conversations` · `GET /{message-id}` (Conversations API) | ❌ | riwayat hanya dari webhook |
| `POST /{page}/moderate_conversations` (block user) | ❌ | — |
| Utility message templates (`message_template_library`, clone) | ❌ | — |
| `GET/POST /{page}/subscribed_apps` | ❌ | langganan webhook manual di dashboard |

Catatan desain yang **sudah benar**: `messaging_type: "RESPONSE"` selalu dipakai dan window 24 jam ditegakkan fail-closed di dispatcher — jadi tidak ada pelanggaran kebijakan Meta. Konsekuensinya: tanpa `message_tag`, kirim di luar window memang tidak mungkin (pilihan sadar, bukan bug).

---

## 7. Detail — Instagram API

| Endpoint | Status | Lokasi |
|---|---|---|
| `POST /{ig-id}/messages` (text, media URL, quick replies, generic template) | ✅ | `instagram.ts:323`, `:353` |
| `POST /{ig-id}/messages` + `recipient.comment_id` (private reply) | ✅ | `:414` |
| `POST /{ig-id}/media` + `media_publish` (+ poll `status_code`) | ✅ | `:454`, `:488`, `:507` |
| Comment: `POST /{comment-id}` hide, `DELETE`, `POST /{comment-id}/replies` | ✅ | `:426` |
| `GET /{ig-id}/insights`, `GET /{media-id}/insights` | ✅ | `:537` |
| OAuth dual-mode (`graph.instagram.com` / `graph.facebook.com`) + refresh | ✅ | `:203`, `:273` |
| `GET /me/accounts?fields=…instagram_business_account` | ✅ | via `messenger.ts:145` |
| Welcome Message Flows API (5) | ✅ | `instagram.ts` → `welcomeFlows` (list/get/create/update/remove); route `/channels/{id}/welcome-flows` |
| `messenger_profile` IG (persistent menu, ice breakers, 6 request) | ✅ | `instagram.ts` → `messengerProfile` (get/set/remove, `platform: "instagram"`); route `/channels/{id}/messenger-profile`. Messenger juga dapat kapabilitas yang sama (`me/messenger_profile`) |
| `GET /{ig-id}/conversations`, `GET /{message-id}` | ❌ | — |
| `POST /{ig-id}/message_attachments` | ❌ | — |
| `GET /{ig-id}/comments` (baca komentar) | ❌ | hanya via webhook `comments` |
| `subscribed_apps` (GET/POST/DELETE) | ❌ | — |
| Hashtag search / product tagging (facebook-login scope) | ❌ | scope diminta, fitur tidak dipakai |
| `GET /{ig-id}` (profil) | ❌ | identitas dari webhook/entry id |

---

## 8. Detail — Threads API

| Endpoint | Status | Lokasi |
|---|---|---|
| `POST /oauth/access_token`, `GET /access_token?grant_type=th_exchange_token`, `GET /refresh_access_token` | ✅ | `threads.ts:128`, `:190`, `:210` |
| `GET /v1.0/me` (profil + avatar) | ✅ | `:167` |
| `POST /{user}/threads` + `threads_publish` (text auto-publish, image, video, reply, quote) | ✅ | `:264` |
| `POST /{reply-id}/manage_reply` (hide/unhide) | ✅ | `:312` |
| `DELETE /{post-id}` | ✅ | `:327` |
| `GET /{id}/insights`, `GET /{user}/threads_insights` | ✅ | `:344` |
| `GET /keyword_search` | ✅ | `:366` |
| Webhook `replies` + `mentions` | ✅ | `:386` |
| Carousel post (`is_carousel_item` + `children`) | ✅ | `publish()` ≥2 media URL (`:264`) |
| `POST /{post}/repost` (repost API) | ❌ | — |
| `GET /{media-id}/replies`, `GET /{media-id}` (baca balasan/media) | ❌ | hanya inbound webhook |
| Location search & tagging (2) | ❌ | scope `threads_location_tagging` diminta tapi tidak dipakai |
| `GET /{media}/conversation`, display/embed | ❌ | — |

Catatan: `send()` sengaja melempar `NotImplementedError` karena Threads **tidak punya DM API** (`threads.ts:256`). Ini benar dan konsisten dengan capability matrix, bukan kekurangan.

---

## 9. Detail — Facebook API (Page)

| Endpoint | Status |
|---|---|
| `GET /me/accounts?fields=name,access_token` | ✅ (`messenger.ts:145`) |
| `GET /{page-id}?fields=picture` | ✅ (`messenger.ts:165`) |
| `POST /me/video_reels` + `rupload.facebook.com/video-upload` (3 langkah Reels) | ❌ — publish Page hanya teks/link |
| `GET /{video-id}?fields=status` | ❌ |

---

## 10. MAPI (Marketing / GenAI / Onboarding) — di luar cakupan

53 endpoint (campaign, adset, ad, adcreative, insights, targeting, pixel, conversion, offline dataset, GenAI text/image expansion/background) **nol implementasi**. Botara bukan ad manager. Ini bukan gap; yang perlu hanya pernyataan eksplisit di dokumentasi agar tidak dianggap janji.

---

## 11. Temuan

### 11.0 Status perbaikan (gelombang 2 — 2026-10-27, ditutup gelombang 3 — 2026-10-27)

| ID | Status | Bukti |
|---|---|---|
| WA-2 reply/quote | **Selesai** | `SendInput.replyToExternalId` → WhatsApp `context.message_id`, Messenger & IG `reply_to.mid`; API `POST /conversations/{id}/reply` menerima `replyToMessageId` (resolusi server-side, 404 lintas-thread, 400 bila pesan tak punya id provider); inbox punya tombol Kutip + chip pembatalan |
| WA-3 mark-as-read & typing | **Selesai** | `ChannelAdapter.markRead?`/`typing?`; WhatsApp `PUT /{phone}/messages` + `typing_indicator`, Messenger/IG sender action `mark_seen`/`typing_on`/`typing_off`; route `POST /conversations/{id}/read` & `/typing` (best-effort, `unsupported_channel` untuk webchat/telegram/email/tiktok); inbox menandai dibaca saat thread dibuka dan mengirim indikator saat agen mengetik |
| WA-4 template lifecycle | **Selesai** | **Pull**: `POST /templates/sync` + `apps/api/src/template-sync.ts` (WABA discovery → `GET /{waba}/message_templates`, paging berbatas 10 halaman → upsert mirror, kini termasuk `components` + `rejected_reason`). **Push**: `apps/api/src/template-write.ts` → `POST /templates/submit` (validator komponen: satu BODY, placeholder `{{n}}` berurutan, plafon tombol per tipe, header media wajib `example.header_handle`; status yang dicerminkan adalah jawaban Meta, bukan asumsi "approved") dan `DELETE /templates/{id}` (hapus di Meta dulu, baru baris lokal). **UI**: composer header/body/footer/tombol + status pill + alasan penolakan + tombol hapus di halaman Broadcast |
| IG-1 welcome flows | **Selesai** | `InstagramAdapter.welcomeFlows` (list dengan paging berbatas, get, create, update, remove) + route `/channels/{id}/welcome-flows` (5 endpoint) + panel "Instagram automation" di halaman Channels. Body flow dikirim sebagai JSON **string** (bentuk yang disimpan Meta), dan baris yang body-nya rusak tetap terdaftar supaya bisa dihapus |
| IG-2 IG messenger profile | **Selesai** | `InstagramAdapter.messengerProfile` (get/set/remove) dengan tag `platform: "instagram"` — tanpa tag itu penulisan bisa mendarat di profil Page yang tertaut. `MessengerAdapter` mendapat kapabilitas yang sama lewat `me/messenger_profile`, jadi setter `setGetStarted`/`setPersistentMenu` yang sebelumnya tak terpakai kini punya jalur baca/hapus. UI: menu persisten + ice breakers di panel yang sama |
| M-1 sender actions + attachment | **Selesai** | Sender action selesai di gelombang 2. **Attachment upload** selesai: `MessengerAdapter.uploadAttachment` / `InstagramAdapter.uploadAttachment` → `POST /{page-id}/message_attachments` (multipart `message` + `filedata`, `is_reusable: true`) → `send({ media: { id } })` memakai `payload.attachment_id`, jadi media **tidak lagi** wajib public URL. Ditutup dengan jalur kirim yang sebelumnya belum ada sama sekali: route `POST /conversations/{id}/attachments` (multipart `file` + `caption`), port `apps/api/src/outbound-media.ts` (validasi tipe/ukuran → simpan ke R2 → pilih jalur termurah per channel), dan tombol "Attach file" di composer inbox |
| TH-1 carousel | **Selesai** | `publish()` dengan ≥2 media URL → container `is_carousel_item` per item (dipoll sampai FINISHED) → container `CAROUSEL` → `threads_publish`; menolak carousel-as-reply dengan pesan jelas |
| P2-1 metrik insights | **Selesai** | `page_post_views` → `page_post_engagements` (`messenger.ts`), dengan komentar alasan |
| P2-3 validasi parameter template | **Selesai** | `POST /broadcasts` menolak `templateParams` yang jumlahnya ≠ jumlah placeholder BODY (`templateBodyParamCount`, null = tidak diketahui → tidak dipaksa), plus gerbang "template harus approved" sebelum enqueue |
| P3-1 suite merah | **Selesai** | 1128 test hijau setelah link workspace dipulihkan (lihat catatan di bawah); 4 error typecheck lama di `outbound-webhooks.test.ts` juga dibereskan |

**Catatan lingkungan Windows:** `bun install` (bahkan `--force`) **tidak** membuat junction `node_modules/@botara/*` di mesin ini — junction-nya dibuat manual (`New-Item -ItemType Junction`). Tanpa itu, impor `@botara/*` dari `apps/web`/`packages/ai` gagal dan suite merah meski kodenya benar. Di CI Linux, `bun install` sudah cukup.

### P1 — gap berdampak langsung ke operasi

| ID | Temuan | Status |
|---|---|---|
| **WA-2** | Tidak ada `context.message_id` di `send()` | ✅ diperbaiki |
| **WA-3** | Tidak ada mark-as-read & typing indicator | ✅ diperbaiki |
| **WA-4** | Template tidak dikelola ke Meta | ✅ diperbaiki (sync + submit + delete + composer) |
| **IG-1** | Welcome Message Flows API tidak ada | ✅ diperbaiki (5 endpoint + panel) |
| **IG-2** | `messenger_profile` IG (persistent menu, ice breakers) tidak ada | ✅ diperbaiki (IG + Messenger) |
| **M-1** | Sender actions + attachment upload | ✅ diperbaiki (upload reusable + route lampiran + UI) |
| **TH-1** | Carousel Threads tidak ada | ✅ diperbaiki |

### P2 — perlu verifikasi terhadap API live

| ID | Temuan | Status |
|---|---|---|
| **P2-1** | `page_post_views` bukan metrik Page Insights → diganti `page_post_engagements` | ✅ diperbaiki (verifikasi live tetap disarankan) |
| **P2-2** | `GET /{waba}/subscribed_apps` belum dipakai untuk health-check | ✅ diperbaiki (`GET /channels/{id}/health`) |
| **P2-3** | Tidak ada validasi jumlah parameter template | ✅ diperbaiki (gate pra-kirim) |
| **P2-4** | Bentuk auth `Bearer` vs `access_token` query | 📝 catatan saja |

### P3 — kebersihan & dokumentasi

| ID | Temuan | Status |
|---|---|---|
| **P3-1** | Suite merah karena link workspace | ✅ beres (lihat catatan Windows di §11.0) |
| **P3-2** | `feature-parity.md` belum memuat cakupan Meta API | ⬜ dokumen ini bisa jadi lampiran |
| **P3-3** | Istilah "flows" ambigu | ⬜ |
| **P3-4** | `message_qrdls` Meta tidak dipakai (QR sendiri) | 📝 catatan saja |

### Rincian temuan awal (dipertahankan sebagai rujukan)

| ID | Temuan | Dampak | Perbaikan |
|---|---|---|---|
| **WA-2** | Tidak ada `context.message_id` di `send()` | agen tidak bisa balas-mengutip; 12 varian "Send Reply to …" tidak terpakai; pelanggan bingung konteks | tambah `replyToExternalId` → `context` di payload |
| **WA-3** | Tidak ada mark-as-read & typing indicator | centang biru tidak pernah muncul; tidak ada "sedang mengetik" | `PUT /{phone}/messages` saat agen buka thread + `typing_indicator` saat mengetik |
| **WA-4** | Template tidak dikelola ke Meta | semua template manual di WhatsApp Manager; broadcast bisa gagal tanpa pre-check | `GET/POST/DELETE /{waba}/message_templates` + kolom `meta_status` |
| **IG-1** | Welcome Message Flows API tidak ada | DM pertama tidak bisa disapa otomatis (fitur standar IG) | 5 endpoint (`onb`-style helper di adapter) |
| **IG-2** | `messenger_profile` IG (persistent menu, ice breakers) tidak ada | tidak ada menu navigasi di DM IG | reuse pola `messenger.ts:405` dengan host IG |
| **M-1** | Sender actions & attachment upload Messenger tidak ada | tidak ada mark_seen/typing; media wajib public URL | `sender_action` + `me/message_attachments` |
| **TH-1** | Carousel Threads tidak ada | publish multi-gambar tidak mungkin | `is_carousel_item` + `children` |

### P2 — perlu verifikasi terhadap API live

| ID | Temuan |
|---|---|
| **P2-1** | `messenger.ts:468` meminta `metric=page_views_total,page_post_views`. `page_post_views` tidak ada di daftar metrik Page Insights yang umum dipakai (`page_post_engagements`, `page_posts_impressions`) — berisiko 400. Uji dengan token nyata, atau ganti ke `page_post_engagements`. |
| **P2-2** | `GET /{waba}/subscribed_apps` belum dipakai, jadi `appSubscription: "failed"` hanya dilaporkan sekali saat onboarding dan tidak pernah dicek ulang. Tambahkan health-check per akun. |
| **P2-3** | Template send hanya passthrough `components`; tidak ada validasi jumlah parameter vs `template_params` broadcast → mismatch parameter baru ketahuan dari error Meta. |
| **P2-4** | Semua adapter WhatsApp/Messenger/IG memakai `Bearer` token. Untuk Facebook Login klasik, sebagian endpoint koleksi memakai `access_token` query — keduanya sah, tapi perlu dicatat saat debugging dengan Postman (copy request dari koleksi akan beda bentuk). |

### P3 — kebersihan & dokumentasi

| ID | Temuan |
|---|---|
| **P3-1** | `bun test packages apps` → **578 pass / 46 fail**. Semua kegagalan berasal dari 2 file `apps/web/src/flows/*` yang tidak menemukan `@botara/flow-engine/graph` karena `apps/web/node_modules/@botara/*` belum ter-link (install basi), bukan bug kode. Jalankan `bun install`. |
| **P3-2** | `docs/feature-parity.md` membandingkan dengan ChatbotX, belum ada baris "cakupan Meta API". Dokumen ini bisa jadi lampirannya. |
| **P3-3** | Istilah "flows" ambigu: `packages/flow-engine` (automation) vs WhatsApp Flows API. Sebut eksplisit di README agar tidak dikira salah satu. |
| **P3-4** | `message_qrdls` Meta tidak dipakai karena Botara punya QR growth-link sendiri. Perlu dicatat agar tidak dilaporkan sebagai bug saat uji Postman. |

---

## 12. Yang sudah benar — dan beberapa lebih maju dari koleksi

- **Signature & verifikasi webhook** dihitung atas raw bytes dengan `timingSafeEqual` (`wa:88`) — sumber bug paling umum, di sini benar.
- **Pinned Graph version** `v26.0` di semua adapter, bisa di-override per deployment.
- **Mapping error Meta** ke taksonomi sendiri: `131063` (kategori template salah), `131049` (marketing di-pause), `130429/80007/4` (rate limit), `190` (token mati) — `wa:52`.
- **Marketing Messages API** (`/{phone}/marketing_messages`) — belum ada di koleksi, sudah dipakai sesuai ADR-008.
- **Coexistence**: `smb_app_data` request + parsing `smb_message_echoes` / `smb_app_state_sync` / `history` (dedupe wamid, arah pesan, timestamp asli) — jauh di atas cakupan koleksi.
- **Instagram dual login** dengan pemilihan host yang benar per `auth_mode`, plus catatan trap bahwa `scope` menimpa default.
- **Threads**: penanganan `user_id` numerik > 2^53 dengan recovery regex dari raw body (`threads.ts:153`) — detail yang mudah terlewat.
- **Catalog sync**: `owned_product_catalogs` → `products` dengan paging berbatas dan hapus baris stale hanya setelah sync penuh.
- **Data deletion callback** dengan verifikasi `signed_request` (`app.ts:704`, `:1860`).
- **Window 24 jam fail-closed** dan **handover protocol** — sesuai kebijakan Meta, bukan hanya sesuai endpoint.
- **Gelombang 2 (2026-10-27):** reply/quote native (`context.message_id` / `reply_to.mid`), read receipt + typing indicator dengan kontrak adapter yang jujur (`markRead?`/`typing?`, `unsupported_channel` alih-alih pura-pura), Threads carousel dengan polling container per item, dan template sync yang memisahkan "apa yang diketik operator" dari "apa yang disetujui Meta".
- **Gelombang 3 (2026-10-27):** template lifecycle dua arah — `POST /templates/submit` memvalidasi pohon komponen dengan aturan Meta **sebelum** memanggil Graph (jadi kesalahan struktural tidak menghabiskan satu putaran review), mencerminkan status balasan Meta apa adanya, dan `DELETE /templates/{id}` menghapus di Meta lebih dulu. Ditambah dua gerbang pra-kirim di `POST /broadcasts`: template wajib `approved`, dan jumlah `templateParams` wajib sama dengan jumlah placeholder BODY.
- **Gelombang 4 (2026-10-27):** Instagram automation sebagai kapabilitas adapter (`welcomeFlows`, `messengerProfile`) alih-alih method longgar di antarmuka — kanal yang tidak punya permukaan itu menjawab `unsupported_channel`/400 dengan satu pemeriksaan. Validator memakai batas resmi Meta (nama flow 100, teks 640, quick reply 20 judul / 11 buah, menu 3 item / 30 karakter, ice breaker 4 / 80 karakter), dan resolver menegakkan batas workspace + keluarga kanal di satu tempat yang bisa diuji tanpa registry.
- **Gelombang 5 (2026-10-27):** M-1 dan P2-2. Lampiran keluar akhirnya punya jalur: validasi → simpan → kirim, dengan Messenger/IG mengunggah bytes ke Meta (tidak perlu public URL) dan WhatsApp/Telegram memakai public URL. Health-check per akun menjawab pertanyaan yang tidak bisa dijawab dashboard mana pun sebelumnya — "apakah app kita masih berlangganan ke WABA ini?" — dengan jawaban tri-state supaya "tidak bisa dipastikan" tidak pernah tampil sebagai "tidak berlangganan".

---

## 13. Status uji

```
bun test packages apps
1231 pass · 0 fail · 6305 expect() calls · 112 files (34.3s)
```

Kondisi awal audit adalah `578 pass · 46 fail`: 2 file gagal me-resolve `@botara/flow-engine/graph` karena symlink workspace di `apps/web/node_modules/@botara/` tidak ada (bukan bug kode). Di mesin Windows ini `bun install` — termasuk `--force` — tidak membuat junction itu, jadi dibuat manual (`New-Item -ItemType Junction`); di CI Linux `bun install` sudah cukup. Setelah itu suite hijau dan tetap hijau sepanjang gelombang 2 dan 3.

`bun run typecheck` bersih di semua workspace. Empat error lama di `apps/api/src/outbound-webhooks.test.ts` (matcher `unknown` vs `string`, dan override `createConversation` yang mengembalikan `string` sementara `InMemoryDispatchStore` menyimpulkan tipe template-literal UUID dari `crypto.randomUUID()`) ikut dibereskan di gelombang 3 — bukan karena perubahan template, tapi karena itu satu-satunya yang membuat typecheck merah.

---

## 14. Rekomendasi urutan kerja

**Gelombang 2 sudah dikerjakan** (lihat §11.0): WA-2, WA-3, TH-1, P2-1, P3-1 selesai.

**Gelombang 3 sudah dikerjakan**: WA-4 ditutup end-to-end (sync + submit + delete + composer + gate "approved" + validasi jumlah parameter), P2-3 selesai.

**Gelombang 4 sudah dikerjakan**: IG-1 dan IG-2 ditutup (welcome flows 5 endpoint + `messenger_profile` untuk IG dan Messenger, dengan panel di halaman Channels).

**Gelombang 5 sudah dikerjakan**: M-1 dan P2-2 ditutup.

1. **M-1 (attachment)** — `uploadAttachment` di adapter Messenger & Instagram (`POST /{page-id}/message_attachments`, multipart, `is_reusable: true`) dan `send({ media: { id } })` yang mengirim `payload.attachment_id`. Yang membuat ini berguna adalah jalur kirim yang sebelumnya tidak ada: `POST /conversations/{id}/attachments` + `apps/api/src/outbound-media.ts` + tombol "Attach file" di composer. Tiga keputusan yang perlu dicatat:
   - **Urutan**: prasyarat (workspace, status akun, window, cap) → validasi tipe/ukuran → baris pesan `queued` → kirim → status. Lampiran yang ditolak tidak pernah meninggalkan objek di storage, dan kirim yang gagal tidak pernah meninggalkan baris `sent`.
   - **Jalur per channel**: Messenger/IG selalu upload (itulah inti M-1: tanpa public URL). WhatsApp memakai public URL bila ada (satu panggilan, caption + filename ikut), jika tidak upload ke Meta dan kirim media id. Telegram hanya public URL dan hanya foto — `send()` belum punya cabang dokumen/audio, jadi tipe lain ditolak dengan alasannya, bukan dikirim sebagai teks.
   - **Caption**: attachment Send API tidak punya field caption, jadi untuk Messenger/IG caption dikirim sebagai pesan teks **lebih dulu**, baru lampiran.
2. **P2-2 (health-check)** — `GET /channels/{id}/health` + `apps/api/src/channel-health.ts`. `adapter.health()` selama ini tidak pernah dipanggil dan tidak pernah menyentuh jaringan; yang benar-benar mematikan akun WhatsApp adalah langganan `subscribed_apps` yang hilang (kirim tetap jalan, pesan masuk berhenti diam-diam). Karena itu jawabannya **tri-state**: `subscribed: true | false | null`, dan `null` (tidak ada `META_APP_ID`, tidak ada token, atau Graph gagal) **tidak boleh** dirender sebagai "tidak berlangganan" — alarm palsu pada akun sehat lebih buruk daripada "tidak bisa dipastikan". Route selalu 200: provider yang gagal adalah laporan (`ok: false` + alasan), bukan 5xx.

Sisa pekerjaan: QR Meta, commerce settings, block users, business profile update, FB Reels, Threads repost/read-replies, IG Conversations API — semuanya backlog P3, dikerjakan hanya bila ada permintaan nyata.

Catatan WA-4: template **tidak bisa** diedit di Meta — perubahan komponen berarti submit ulang (Meta mem-version-kan template) atau hapus lalu buat baru. Karena itu panel hanya menyediakan submit + hapus, bukan "edit": tombol edit yang hanya mengubah baris lokal akan berbohong tentang apa yang dipegang Meta.

Catatan IG-2: `messenger_profile` **mengganti** field yang dikirim, bukan menggabungkan. Karena itu route `PUT` hanya mengirim bagian yang ada di body (menu saja, atau ice breaker saja) — mengirim objek kosong akan menghapus profil yang sudah ada. Validator menolak body kosong justru karena alasan itu.

Setiap langkah di atas mengikuti aturan repo: route baru **wajib** punya pemanggil di `apps/web` atau entri di `route-parity.ts` + `docs/api-ui-parity.md`, dan test-nya ikut di commit yang sama.

---

## Lampiran A — cara reproduksi audit

```bash
# 1. Inventaris endpoint koleksi
cd E:/PROJECTS/Meta-doc-postman-collection
python - <<'PY'
import json,glob,re
for fn in sorted(glob.glob('*.json')):
    d=json.load(open(fn,encoding='utf-8')); seen=set()
    def walk(items):
        for it in items:
            if 'item' in it: walk(it['item'])
            else:
                r=it.get('request',{}); m=(r.get('method') or 'VIEW').upper()
                u=r.get('url',{}); raw=u.get('raw','') if isinstance(u,dict) else str(u)
                seen.add((m,re.sub(r'\{\{[^}]+\}\}','*',re.sub(r'\?.*$','',raw.split('\n')[0]))))
    walk(d['item'])
    print(fn, len(seen))
PY

# 2. Panggilan Graph di repo
cd E:/PROJECTS/chatbot/botara
grep -rn "graph.facebook.com\|graph.instagram.com\|graph.threads.net" \
  packages/channels/src apps/api/src --include="*.ts" | grep -v test

# 3. Suite test
bun test packages apps
```
