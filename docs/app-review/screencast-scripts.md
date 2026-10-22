# Meta App Review — Screencast Scripts

Shot-by-shot scripts for the review videos. Record at 1080p with the
browser zoomed to 100–125%; narrate or caption each numbered step (Meta
accepts on-screen captions). Use the REVIEW TEST business / accounts
from `submission-checklist.md`, never real customer data. Keep each
video focused: one permission group per video, 1–3 minutes each.

General setup for every video:

- Web app: `https://botara.my.id` (log in with the review test user).
- Keep a second tab open on the channel itself (WhatsApp phone /
  Instagram app / Messenger / Threads) to show cause → effect.
- Start each video on the Botara Dashboard with the workspace switcher
  showing the test workspace.

---

## W1 — `whatsapp_business_messaging`

1. Show the test WhatsApp number connected under **Channels** (name +
   number visible).
2. From a personal phone, send "halo, apakah stok tersedia?" to the
   business number.
3. Switch to **Inbox**: the message arrives in real time; the window
   badge shows the 24h service window open.
4. Reply from the inbox ("Halo! Stok tersedia…"). Show the reply landing
   on the phone.
5. Open **Broadcast**: create a small broadcast with an approved utility
   template to the test contact list; send; show the delivery arriving
   on the phone and the sent count updating.
6. (Optional) Open **Flows**: show a keyword flow ("halo" → welcome
   message) and trigger it from the phone.

## W2 — `whatsapp_business_management`

1. From **Channels → Connect WhatsApp**, launch Embedded Signup; log in
   with the test business, pick the test WABA + number, finish.
2. Show the number appearing in the channel list with its metadata.
3. Open **Templates**: create a template (`order_update`, utility,
   id) and submit; show status "pending" syncing from Meta.
4. Show the template category/status column updating after Meta's
   decision (or point at an already-approved test template and its
   synced category).

## I1 — `instagram_basic` / `instagram_business_basic`

1. **Channels → Connect Instagram** (record once per login mode you
   submit; say on camera which mode this is).
2. Complete the OAuth; show the connected account card: username +
   profile picture + mode badge (Facebook Login / Instagram Login).

## I2 — `instagram_content_publish` / `instagram_business_content_publish`

1. Open **Publish → New post**; pick the Instagram account.
2. Upload one photo; write a caption; choose "Publish now". Show the
   success state with the external post id.
3. Open Instagram and show the post live on the profile.
4. Repeat with a short video (reel) — pause on Botara's "publishing"
   state to show the container-processing wait, then show the reel live.
5. (Threads cross-step, if requested) Also record scheduling a post 5
   minutes ahead and it appearing at the scheduled time.

## I3 — `instagram_manage_comments` / `instagram_business_manage_comments`

1. Comment on the test post from a personal account ("berapa harganya?").
2. In Botara's post/moderation view, show the comment appearing.
3. Reply to the comment from Botara; show the reply on Instagram.
4. Click **Private reply** and send a DM answer; show it in the personal
   account's Instagram DMs (one per comment, per policy).
5. Hide a second spammy comment from Botara; show it hidden on Instagram.

## I4 — `instagram_manage_messages` / `instagram_business_manage_messages`

1. DM the business account from a personal account.
2. Show the DM arriving in Botara **Inbox** with the 24h window badge.
3. Reply from Botara; show the reply in Instagram DMs.
4. (If Human Agent feature is requested) Reply to a 2-day-old thread and
   caption that this uses the Human Agent tag within 7 days.

## M1 — `pages_messaging` (+ `pages_manage_metadata`, `pages_show_list`)

1. **Channels → Connect Page**: show the Page picker listing the user's
   Pages (`pages_show_list`); select the test Page; show the webhook
   subscription success state (metadata).
2. Message the Page from a personal Messenger account.
3. Show the conversation in **Inbox**; reply from Botara; show the reply
   in Messenger.

## T1 — `threads_basic`

1. **Channels → Connect Threads**; complete Threads OAuth.
2. Show the connected profile card (username + picture) in Botara.

## T2 — `threads_content_publish` (+ optional `threads_location_tagging`, `threads_delete`, `threads_share_to_instagram`)

1. **Publish → New post** targeting Threads: text + one image (public
   URL); publish now; show the post live on Threads.
2. Schedule a text post 5 minutes ahead; show it publishing on time
   (caption: "Threads has no native scheduler — Botara schedules").
3. Optional steps (only if requesting those scopes): attach a location
   in the composer and publish; delete a Botara-published post from the
   Publish history and show it gone; tick "share to Instagram" and show
   the cross-post.

## T3 — `threads_read_replies` / `threads_manage_replies`

1. Reply to the business's Threads post from a personal account.
2. Show the reply collected in Botara's Threads moderation view.
3. Reply to it from Botara; show the reply on Threads.
4. Hide a reply from Botara; show the hidden state on Threads.

## T4 — `threads_manage_insights`

1. Open **Publish/Analytics** for the Threads account.
2. Show profile + post insights (views, replies, reposts) rendered from
   the API for the test account's own posts.

## T5 — `threads_keyword_search` / `threads_manage_mentions`

1. Open the Threads listening view; search the test brand keyword; show
   matching public posts.
2. Post a @mention of the business from a personal account; show it
   arriving in the mentions queue.

---

### Recording checklist

- [ ] No real customer data, phone numbers, or tokens on screen.
- [ ] Each video states which permission it demonstrates (caption).
- [ ] The connected test accounts match the ones in the submission.
- [ ] Videos uploaded to the exact permission rows they cover.
