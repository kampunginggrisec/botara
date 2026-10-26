# Setup Meta Developer untuk WhatsApp SaaS Botara

Panduan ini ditujukan kepada operator platform Botara. Satu aplikasi Meta
milik Botara menjalankan **Embedded Signup**, sementara setiap pelanggan
menghubungkan WhatsApp Business Account (WABA) dan nomor mereka sendiri dari
halaman **Channels**. Token pelanggan disimpan per akun di vault terenkripsi,
bukan di browser atau konfigurasi bersama.

Untuk detail seluruh kanal Meta, lihat [meta-setup.md](meta-setup.md).
Jika nama menu Meta berubah, gunakan dokumentasi resmi Meta pada akhir file
sebagai rujukan utama.

## Prasyarat dan kepemilikan

| Aset | Pemilik | Catatan |
|---|---|---|
| Meta app dan Configuration ID | Botara / EB Malang | Satu konfigurasi untuk onboarding banyak pelanggan. |
| WABA dan nomor | Pelanggan | Dipilih/dibuat pelanggan di popup Meta. |
| Token akses pelanggan | Botara vault | Tidak boleh masuk ke frontend, chat, atau git. |
| Webhook HTTPS | Deployment Botara | Menerima event dari seluruh akun pelanggan. |

Sebelum mulai, akun operator harus menjadi **admin EB Malang** dan memiliki
role **Admin** pada app Meta yang benar. App tersebut harus memiliki produk
WhatsApp/Business Messaging.

## 1. Siapkan deployment Botara

Gunakan domain HTTPS publik. Contoh berikut memakai `https://app.botara.example`:

```text
APP_PUBLIC_URL=https://app.botara.example
PUBLIC_WEBHOOK_BASE_URL=https://app.botara.example/api
```

URL yang dimasukkan ke Meta:

```text
Webhook WhatsApp: https://app.botara.example/api/webhooks/whatsapp
Data deletion:    https://app.botara.example/api/webhooks/meta/data-deletion
```

Di **Admin → Settings → Meta** Botara, isi dengan aman:

| Kunci | Kegunaan |
|---|---|
| `META_APP_ID` | App ID aplikasi Meta utama. |
| `META_APP_SECRET` | Verifikasi signature webhook dan pertukaran signup. |
| `WHATSAPP_VERIFY_TOKEN` | String acak kuat milik operator. |
| `WHATSAPP_EMBEDDED_CONFIG_ID` | Configuration ID dari langkah 3. |

Production juga membutuhkan `DATABASE_URL`, `SESSION_SECRET`, dan
`TOKEN_VAULT_KEY`. Botara menolak boot bila webhook atau Embedded Signup
diaktifkan tanpa kredensial Meta yang wajib.

## 2. Buat dan lengkapi app Meta

1. Di Meta for Developers, buat atau pilih app tipe **Business** yang
   dimiliki EB Malang.
2. Tambahkan produk/use case WhatsApp atau Business Messaging.
3. Pada **Settings → Basic**, isi App Domains, Website URL, Privacy Policy
   URL, Terms URL, dan Data Deletion Request URL.
4. Tambahkan domain Botara ke daftar domain JavaScript SDK/Facebook Login
   for Business yang diizinkan.
5. Simpan App ID dan App Secret hanya lewat Panel Admin Botara atau secret
   manager deployment.

## 3. Buat konfigurasi Embedded Signup v4

Di **Facebook Login for Business → Configurations**:

1. Buat konfigurasi dengan variasi **WhatsApp Embedded Signup**.
2. Pilih WhatsApp Cloud API; tambahkan Marketing Messages API bila akan
   memakai kampanye marketing dan opsi tersebut tersedia.
3. Pilih asset WhatsApp accounts serta izin minimum
   `whatsapp_business_management` dan `whatsapp_business_messaging`.
4. Aktifkan Client OAuth Login, Web OAuth Login, Enforce HTTPS, dan Login
   with the JavaScript SDK bila opsi tersebut tersedia.
5. Salin Configuration ID ke `WHATSAPP_EMBEDDED_CONFIG_ID`.

Configuration ID boleh sampai ke browser; App Secret tidak boleh.

## 4. Konfigurasi webhook WhatsApp

Di WhatsApp → Configuration/Webhooks pada app Meta:

1. Masukkan callback URL `https://app.botara.example/api/webhooks/whatsapp`.
2. Masukkan nilai persis `WHATSAPP_VERIFY_TOKEN`, lalu verifikasi dan simpan.
3. Langgankan field berikut.

| Field | Status | Fungsi |
|---|---|---|
| `messages` | Wajib | Pesan masuk, status delivery/read, dan balasan. |
| `template_category_update` | Disarankan | Menjaga kategori template Botara sinkron. |
| `smb_message_echoes` | Disarankan | Pesan keluar dari aplikasi Business muncul di Inbox. |
| `smb_app_state_sync` | Disarankan | Sinkronisasi kontak coexistence. |
| `history` | Disarankan | Backfill riwayat coexistence. |

Botara memverifikasi `X-Hub-Signature-256` memakai `META_APP_SECRET`.

## 5. Uji onboarding pelanggan pertama

1. Masuk sebagai owner/admin workspace uji Botara.
2. Buka **Channels → Connect WhatsApp** dan selesaikan popup Meta sebagai
   pemilik bisnis pelanggan.
3. Pilih/buat Business Portfolio, WABA, dan nomor pelanggan.
4. Pastikan akun terlihat `connected`, lalu kirim pesan masuk dan balas dari
   Inbox Botara.
5. Uji pesan di luar jendela 24 jam menggunakan template Meta yang disetujui.

Nomor test Meta hanya untuk smoke test dan dibatasi allow-list; jangan
menjadikannya bukti kesiapan pelanggan produksi.

## 6. WhatsApp coexistence

Coexistence memungkinkan nomor yang sama tetap dipakai di aplikasi WhatsApp
Business dan Cloud API Botara. Bila Meta menawarkan opsi ini saat signup,
Botara akan menandai akun sebagai coexistence, meminta sinkronisasi kontak
dan riwayat, dan menampilkan pesan yang dikirim dari aplikasi Business sebagai
pesan keluar di Inbox. Kelayakan nomor dan negara tetap diputuskan Meta.

## 7. Go-live

- Lengkapi profil EB Malang dan business verification jika diminta Meta.
- Pindahkan app ke mode Live setelah legal page dan konfigurasi selesai.
- Ajukan App Review untuk izin WhatsApp; gunakan `docs/app-review/` untuk
  materi pengajuan.
- Ulangi test webhook dan Embedded Signup setelah app Live karena mode
  Development terbatas pada role app/tester.

## Checklist

- [ ] Operator admin di EB Malang dan app Meta yang benar.
- [ ] Domain Botara HTTPS dapat dijangkau Meta.
- [ ] Kredensial Meta tersimpan aman di Botara/deployment.
- [ ] Webhook tervalidasi dan field `messages` berlangganan.
- [ ] Embedded Signup, pesan masuk, balasan, dan template telah diuji.
- [ ] Coexistence diuji hanya bila Meta menawarkannya.
- [ ] Legal page, business verification, dan App Review selesai sebelum
      onboarding pelanggan produksi.

## Referensi Meta

- [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Onboard Business App users / coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [WhatsApp webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)
