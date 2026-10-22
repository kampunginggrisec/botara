# Meta App Review — Submission Checklist

Ordered end-to-end. **[OWNER]** steps can only be done by the Meta
account/business owner personally (identity, business verification,
payment/legal attestations) — they cannot be delegated. **[PREPARED]**
steps are already built/drafted in this repo; the owner only pastes or
clicks.

Replace `botara.my.id` with the production domain everywhere if it
changes, and keep this file updated with the real ids (never secrets —
app secrets go into the server env / Secure Vault, NOT into git).

## 0. Prerequisites

- [ ] **[OWNER]** Meta developer account in good standing.
- [ ] **[OWNER]** A verified business (Business Settings → Business
      Info) — business verification can take days; start FIRST.
- [ ] **[OWNER]** Production domain live over HTTPS with Botara deployed
      (trial: `https://botara.my.id`).
- [ ] **[PREPARED]** Privacy + Terms pages live at
      `https://botara.my.id/privacy` and `/terms`.
- [ ] **[PREPARED]** UI language: the web app **defaults to English**
      (Fase 4 i18n, EN + ID dictionaries). Reviewers see English without
      touching anything; the EN | ID switcher is in the top-right of the
      app shell and on the sign-in page (persisted per-browser as
      `botara.lang`). Privacy/Terms pages follow the selected language.
      The app also ships a light/dark theme toggle next to the language
      switcher (default follows the OS setting).
- [ ] **[OWNER]** ⚠️ The /privacy and /terms texts in the app are
      TEMPLATES (marked as such). Have them reviewed/adjusted for the
      real business (legal name, address, privacy contact email, dates)
      before submitting — reviewers do open these pages.

## 1. Create the apps

- [ ] **[OWNER]** Create ONE Meta app (type: Business) for WhatsApp +
      Instagram (Facebook Login) + Messenger. Record the App ID.
- [ ] **[OWNER]** Add a **Threads use case** (Meta treats Threads as its
      own API surface/app flow — follow the Threads use-case wizard in
      the same or a separate app as Meta currently requires). Record its
      App ID separately.
- [ ] **[OWNER]** Create the Instagram **Instagram Login** configuration
      too (Business Login for Instagram) if submitting the
      `instagram_business_*` scopes.
- [ ] **[PREPARED]** Scope list to request: exactly the permissions in
      `permissions.md` — nothing more.

## 2. Configure the apps (ids into server env)

- [ ] **[OWNER]** Put the app credentials into the server environment
      (via Secure Vault / server `.env`, never chat or git):
      `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_*` (Embedded Signup
      config id), Threads app id/secret, plus the platform config ids
      below.
- [ ] **[OWNER]** WhatsApp → Embedded Signup: create the Signup
      configuration (v4 — v2/v3 are retired), note the **config id**,
      put it in env for the connect flow.
- [ ] **[OWNER]** OAuth redirect URIs: add the Botara callback URLs
      shown on the Channels connect screens for Instagram / Threads /
      Facebook Login.
- [ ] **[OWNER]** App domains + website URL: `botara.my.id`.

## 3. Webhooks (URLs prepared — paste into each product's config)

All URLs hang off the API origin (the `/api` prefix is Botara's public
mount; the app strips it in the trial nginx layout):

- [ ] **[OWNER]** WhatsApp webhook:
      `https://botara.my.id/api/webhooks/whatsapp`
      verify token = env `WHATSAPP_VERIFY_TOKEN`; subscribe `messages`
      (+ template status fields).
- [ ] **[OWNER]** Instagram (Facebook Login): Page webhook →
      `https://botara.my.id/api/webhooks/instagram`
- [ ] **[OWNER]** Messenger: Page webhook →
      `https://botara.my.id/api/webhooks/messenger`
      fields: `messages`, `messaging_postbacks`, `message_deliveries`.
- [ ] **[OWNER]** Threads webhook:
      `https://botara.my.id/api/webhooks/threads`
- [ ] **[OWNER]** **Data deletion callback (REQUIRED for approval)**:
      `https://botara.my.id/api/webhooks/meta/data-deletion`
      — implemented: verifies the `signed_request` HMAC with
      `META_APP_SECRET`, returns `{ url, confirmation_code }`; status
      page pattern: `https://botara.my.id/api/data-deletion/status/<code>`.
      Also fill the "Data deletion instructions URL" field with
      `https://botara.my.id/privacy` (section 4).
- [ ] **[PREPARED]** Verify each webhook with Meta's "Verify and save" —
      the API implements the GET challenge for WhatsApp/Instagram/
      Messenger/Threads.

## 4. Test assets

- [ ] **[OWNER]** Add review test users / test business assets in the
      app dashboard (test Instagram professional account, test Page,
      test Threads profile, test WhatsApp number via the test WABA or a
      real number on the business).
- [ ] **[OWNER]** Create a Botara review account and hand Meta the
      credentials in the submission notes:
      register at `https://botara.my.id` → workspace "App Review" with
      the test channels connected.
- [ ] **[PREPARED]** Screencasts: record per `screencast-scripts.md`
      (W1–W2, I1–I4 per login mode, M1, T1–T5).

## 5. Submit

- [ ] **[OWNER]** Paste the justification from `permissions.md` into
      each permission row; attach the matching screencast.
- [ ] **[OWNER]** In "App Review → Requests", describe the app in one
      paragraph (omnichannel inbox + automation for businesses) and give
      the reviewer the step-by-step test instructions (login → Channels
      shows the test accounts already connected → Inbox → send a test
      message).
- [ ] **[OWNER]** Submit, then monitor App Review messages daily —
      reviewers commonly ask for a working test login or a re-recorded
      video; respond within their deadline.
- [ ] **[OWNER]** After approval: switch the app to **Live** mode,
      re-connect production channels (dev-mode tokens are limited), and
      re-run the end-to-end checks in the deploy doc.

## Already implemented & waiting on the submission (do not rebuild)

- [x] **[PREPARED]** WhatsApp Embedded Signup v4 exchange + token vault
      storage.
- [x] **[PREPARED]** Data-deletion callback + public status endpoint
      (tested with signed payloads).
- [x] **[PREPARED]** Privacy/Terms public pages (template text — owner
      review pending, see step 0).
- [x] **[PREPARED]** All webhook verifications + signature checks.
- [x] **[PREPARED]** Token-refresh worker for Threads/Instagram
      long-lived tokens (60-day cycle).
