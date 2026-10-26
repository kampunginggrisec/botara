# TikTok Business Messaging - setup guide

Botara supports TikTok as a **reactive DM channel** through the TikTok API
for Business (v1.3, Business Messaging, currently **Open Beta**). This
guide covers what the operator must do on TikTok's side before any
business can connect, what to configure in Botara, and the product rules
TikTok imposes (they are enforced in code, not just documented).

Research basis: `~/workspace/chatbot-platform/tiktok-docs-check-2026-10-26.md`.
TikTok's full Business Messaging reference is partner-gated, so several
endpoint details were sourced from official documentation text reproduced
in SDK packages plus consistent partner documentation. Items marked
**UNVERIFIED** below must be confirmed from the gated documentation once
access is approved.

## 1. Create the TikTok app (platform operator, one time)

1. Create a developer account at
   <https://business-api.tiktok.com/portal/apps> (TikTok for Business
   developer portal).
2. Create an app and note its **App ID** - it is also the OAuth
   `client_key`.
3. Apply for the **Business Messaging** use case / access review and wait
   for approval. Without approval, businesses cannot authorize messaging.
   (There is no messaging sandbox; testing happens on a real account.)
4. Register the OAuth redirect URI in the app:

   ```
   {PUBLIC_WEBHOOK_BASE_URL}/channels/tiktok/oauth/callback
   ```

   With the trial deployment that is
   `https://dev.botara.my.id/api/channels/tiktok/oauth/callback`.
5. Configure the app webhook URL to `{PUBLIC_WEBHOOK_BASE_URL}/webhooks/tiktok`
   so DM events and high-intent comment events reach Botara.

## 2. Botara configuration

Set in the server environment (`.env`), then restart api + worker:

```bash
TIKTOK_APP_ID=            # the app id / client_key from step 1
TIKTOK_APP_SECRET=        # the app secret (webhook-verification key)
# TIKTOK_ACCESS_TOKEN=    # optional, DEVELOPMENT-ONLY single-account stub
```

When `TIKTOK_APP_ID` is set, `/config/public` reports it and the
Channels page shows the **Connect TikTok** button; otherwise the card
shows a "not configured" notice (same honest-gating pattern as WhatsApp
Embedded Signup).

Connecting: Channels -> TikTok -> Connect TikTok -> approve on TikTok.
Botara exchanges the code for an access + refresh token pair, reads the
business identity (`open_id`, display name) and stores the pair
AES-256-GCM-encrypted in the token vault on the channel account.

## 3. Per-business eligibility checklist

A business can only connect and message when ALL of these hold:

- The account is a **TikTok Business Account** (personal and creator
  accounts are excluded).
- Direct messages are **open to everyone** in the account's settings.
- The account is **linked to TikTok for Business / a Business Center**
  (required for "Advanced Access" since April 2026).
- The business is **not** in an excluded region: EEA, Switzerland, the
  UK and India are excluded; the US opened around November 2025;
  Indonesia and Southeast Asia are core supported markets.
- Comment-to-DM additionally requires the business to be registered in
  **Vietnam, Indonesia or Thailand**, commenters in APAC/LATAM/METAP,
  and only fires for comments TikTok flags as **high-intent** on the
  business's own videos (see section 5).

## 4. Product rules (enforced in Botara)

TikTok Business Messaging is **reactive only**:

- **No business-initiated messages.** There is no way to start a
  conversation. Broadcasts reject TikTok accounts with a typed error
  (`CHANNEL_INITIATION_UNSUPPORTED`), sequence creation is refused and
  any legacy enrollment fails terminally, and growth links do not offer
  TikTok.
- **48-hour reply window.** Replies are only possible within 48 hours
  of the customer's last message (Botara's standard window closes the
  conversation after that; the same setting drives the inbox hint).
- **Maximum 10 consecutive business messages** since the customer's last
  message. Enforced at the inbox reply route and in the worker for
  flow/sequence sends (`CONSECUTIVE_SEND_CAP`, HTTP 422); the step fails
  with that typed reason instead of calling the provider.
- **No clickable links in DMs.** URL buttons do not exist; rich button
  blocks map onto TikTok QA cards whose buttons are **reply buttons
  only** (tapping one sends the button's text as the customer's answer,
  which Botara matches as a postback). Card titles are capped at 40
  characters (button labels at 20); extra buttons degrade to text with
  a typed warning.
- **Media:** inbound images/videos are downloaded into Botara storage
  like other channels. Sending images may be market-gated per
  conversation (`IMAGE_SEND` capability); when TikTok refuses, the send
  fails with the provider's typed error.
- **Tokens:** access tokens live ~24h. Botara refreshes proactively
  (within 30 minutes of expiry, including already-expired access
  tokens - the refresh token is the long-lived credential) and on a 401
  from the provider. A failed refresh marks the account
  `refresh_failed` (= needs re-authorization: reconnect from Channels).

## 5. Comment-to-DM

When TikTok flags a high-intent comment on the business's own video, it
sends the `im_receive_high_intent_comment` webhook event. Botara opens a
conversation and runs matching `comment_keyword` flows; the first DM is
sent with TikTok's `direct_reply` reference to the comment. Public
comment replies and hiding are **not** part of the Business Messaging
API (they belong to a separate Accounts API Botara does not integrate),
so the comment-action pipeline records those steps as skipped for
TikTok. Enable the feature per account via the direct-reply settings
(`/business/message/direct_reply/` in the API - adapter-level support).

## 6. UNVERIFIED items - confirm after access approval

These could not be verified from public sources while building this
integration. Confirm each from the gated TikTok documentation and adjust
the code where reality differs:

1. **Webhook signature scheme.** Botara currently verifies `POST
   /webhooks/tiktok` with an HMAC-SHA256 of the raw body keyed by
   `TIKTOK_APP_SECRET` (header `x-tiktok-signature` or `x-signature`,
   hex, optionally `sha256=`-prefixed) **only when the secret is
   configured** - a PLACEHOLDER scheme. Partner docs confirm a signature
   with a ~5-second timestamp tolerance exists; the exact construction
   must be confirmed and the placeholder replaced.
2. **Full webhook event catalogue and payload schemas.** Only
   `im_receive_high_intent_comment` is a confirmed event name. The DM
   parser accepts the conversation/content-list message shape inside any
   reasonable envelope and ignores unknown events - re-check against
   real payloads after the first live webhook arrives.
3. **Comment-to-DM send shape.** Implemented per the SDK-documented
   `direct_reply` object (`reply_type: "COMMENT_REPLY"` with the comment
   id, no recipient fields). Confirm against a real high-intent comment.
4. **Refresh-token lifetime.** Sources conflict (30 days per one partner
   vs 365 days per TikTok's general OAuth docs). Botara's design (treat
   the refresh token as valid until the provider rejects it) works
   under either; if the lifetime turns out short, expect periodic
   re-authorization prompts.
5. **Media limits and download method.** Image upload documented as
   JPG/PNG <= 3 MB via the SDK-reproduced text (a partner lists 20 MB);
   media download implemented as POST (one integration reference shows
   GET). Confirm both; the download URL is fetched with the
   `x-user: <Access-Token>` header.
6. **OAuth scopes.** The authorize request asks for `user.info.basic`;
   the messaging grant itself is applied at app level in the portal. If
   TikTok requires messaging scopes on the authorize URL, add them in
   `packages/channels/src/tiktok.ts` (`buildTikTokAuthorizeUrl`).

## 7. What Botara does NOT do on TikTok

- No broadcasts, sequences, scheduled posts or growth links (reactive
  only - see section 4).
- No public comment management (reply/hide/like) - not in this API.
- No insights/analytics pull, no contact export to TikTok, no catalog.
