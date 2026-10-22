# Meta App Review — Permission Justifications (paste-ready)

Botara is an omnichannel chatbot platform for businesses: one inbox,
visual flow automations, broadcasts, and scheduled publishing across
WhatsApp, Instagram, Messenger, and Threads. Every permission below maps
to a feature that **already exists in the product** — the reviewer can
reproduce each one with the screencast scripts in
`screencast-scripts.md`.

> How to use: in App Review, paste the justification under the matching
> permission. Replace `botara.my.id` with the production domain if it
> differs. Do not request permissions that are not listed here — the app
> must not ask for anything the product does not use.

---

## WhatsApp Business Platform

### `whatsapp_business_messaging`

> Botara lets a business talk to its own customers on WhatsApp from a
> shared team inbox. With this permission the app (1) receives inbound
> customer messages via webhook and displays them in the Botara inbox,
> (2) sends agent replies inside the 24-hour customer-service window,
> (3) sends approved template messages outside the window (utility,
> authentication, and marketing via the Marketing Messages API), and
> (4) runs opt-in broadcasts and automated flows the business configures.
> Messages are only ever sent to people who messaged the business or
> explicitly opted in. Demo: screencast script W1.

### `whatsapp_business_management`

> Botara onboards businesses through WhatsApp Embedded Signup (v4) and
> then manages the connected assets on the business's behalf: it reads
> the WABA and phone-number metadata to display the connected numbers,
> registers/syncs message templates (creating templates and reading
> their approval status and category updates via webhook), and reads
> phone-number quality/messaging-limit information so the business can
> see the health of its numbers inside Botara. No assets outside the
> business's own WABA are touched. Demo: screencast script W2.

---

## Instagram — Facebook Login mode (`graph.facebook.com`, Page-linked)

### `instagram_basic`

> Botara shows the business which Instagram professional account is
> connected to its Facebook Page (username, profile picture) in the
> channel list, so the team can confirm the right account before
> automating or publishing. Read-only identity display. Demo: I1.

### `instagram_content_publish`

> Businesses compose posts and reels once in Botara's Publish calendar
> and publish them to their own Instagram account, including scheduled
> publishing. Botara creates the media container, waits for processing
> to finish, and calls media_publish. Only content the business itself
> uploaded in Botara is published. Demo: I2.

### `instagram_manage_comments`

> Customer comments on the business's posts appear in Botara (inbox and
> moderation views). The business can reply to, hide, or delete comments
> from Botara, and can send the single allowed private reply (one DM per
> comment within 7 days) to move a public question into a private
> conversation. Demo: I3.

### `instagram_manage_messages`

> Instagram DMs to the business's professional account are received via
> webhook into the Botara omnichannel inbox, where agents reply within
> the 24-hour messaging window (and up to 7 days for human-agent replies
> where approved). Automated flows the business builds can also answer
> common questions. Demo: I4.

### `pages_show_list` / `pages_read_engagement` / `pages_manage_metadata`

> Required to discover the Pages the business admin manages, identify
> the Page linked to the Instagram account, and subscribe the app to the
> Page's webhooks so Instagram/Messenger events reach Botara. Without
> these, the Facebook-Login connection mode cannot be established.

---

## Instagram — Instagram Login mode (`graph.instagram.com`)

For businesses that connect with their Instagram credentials directly
(no Facebook Page). Botara supports both login modes because Meta
offers both; the feature set is the same, the scopes differ.

### `instagram_business_basic`

> Same use as `instagram_basic`: display the connected professional
> account's identity (username, profile picture) in Botara's channel
> list. Demo: I1.

### `instagram_business_content_publish`

> Same use as `instagram_content_publish`: publish business-composed
> posts and reels (including scheduled publishing) to the business's own
> account via the container flow. Demo: I2.

### `instagram_business_manage_comments`

> Same use as `instagram_manage_comments`: read, reply to, hide, and
> delete comments on the business's posts, plus the one allowed private
> reply per comment. Demo: I3.

### `instagram_business_manage_messages`

> Same use as `instagram_manage_messages`: receive and reply to the
> business's Instagram DMs in the Botara inbox within the 24-hour window.
> Demo: I4.

---

## Messenger

### `pages_messaging`

> Messenger conversations with the business's Page arrive in the same
> Botara inbox as every other channel. Agents reply within the 24-hour
> window; approved message tags / template-style messages are used
> outside it, per Messenger policy. Botara's self-built webchat widget
> is a separate surface and does not depend on Messenger. Demo: M1.

### `pages_manage_metadata`

> Required to subscribe the app to the Page's `messages`,
> `messaging_postbacks`, and `message_deliveries` webhook fields so
> Messenger events reach Botara at all. Demo: M1 (setup step).

### `pages_read_engagement`

> Used to display the Page's identity and basic engagement context
> (Page name/picture, conversation metadata) in Botara's channel and
> inbox views so agents know which Page a conversation belongs to.

### `pages_show_list`

> Lists the Pages the user administers during Page connection, so the
> business picks the correct Page to connect.

---

## Threads (separate Meta app / use case, `graph.threads.net`)

### `threads_basic`

> Displays the connected Threads profile (username, profile picture) in
> Botara's channel list so the business confirms the right account.
> Demo: T1.

### `threads_content_publish`

> Businesses compose Threads posts in Botara's Publish calendar and
> publish them (text, image, video, carousel) to their own profile,
> including scheduled publishing — Threads has no native scheduler, so
> this is a core Botara feature. Media is hosted on Botara's public
> media domain because the Threads API fetches media from public URLs.
> Demo: T2.

### `threads_read_replies`

> Replies to the business's Threads posts are collected into Botara so
> the team can triage them alongside other channels. Demo: T3.

### `threads_manage_replies`

> Agents reply to, hide, and unhide replies on the business's own
> Threads posts from Botara's moderation view. Demo: T3.

### `threads_manage_insights`

> Botara's analytics view shows the business its own Threads profile and
> post insights (views, likes, replies, reposts, quotes — the metrics
> the API exposes). Demo: T4.

### `threads_keyword_search`

> Botara's listening feature lets a business search public Threads posts
> for its own brand/product keywords and bring matching posts into a
> review queue. Demo: T5.

### `threads_manage_mentions`

> Posts that @mention the business's Threads profile surface in Botara's
> inbox/listening queue so the team can respond promptly. Demo: T5.

### `threads_location_tagging`

> When a business composes a Threads post in Botara about a physical
> location (a store, café, event), it can attach the location the API
> offers. Only used inside the post composer, only at the user's
> explicit action. Demo: T2 (optional step).

### `threads_delete`

> A business can delete its own Threads post from Botara's Publish
> history (e.g. a post published with an error). Only the account's own
> posts can be deleted, only at the user's explicit action. Demo: T2.

### `threads_share_to_instagram`

> The Publish composer offers an explicit "also share to Instagram"
> action for a Threads post the business just created; used only when
> the user ticks that option. Demo: T2 (optional step).

> Note for the reviewer: Threads has no DM or like API and Botara does
> not request or simulate one — Threads automation in Botara is
> publishing, replies, mentions, keyword listening, and insights only.

---

## Data handling (all products)

- Channel credentials are stored encrypted at rest (AES-256-GCM token
  vault) and are only used to call Meta APIs for the owning workspace.
- Data deletion callback: `POST https://botara.my.id/api/webhooks/meta/data-deletion`
  (signed_request verified). Status page: `https://botara.my.id/api/data-deletion/status/<confirmation_code>`.
- Privacy policy: `https://botara.my.id/privacy` · Terms: `https://botara.my.id/terms`
  (both are templates the business owner finalizes before submission —
  see `submission-checklist.md`).
