# Rich messages: buttons that visitors can tap

A **rich block** is a message with structured choices attached - buttons
or a list - instead of plain text. You author it once (in a flow's
`send_message` node or in the inbox composer's "Add buttons" mode) and
each channel renders it the way that channel supports; anything a
channel cannot render degrades to formatted plain text with a typed
warning (`RICH_DEGRADED_TO_TEXT`), never silently.

## The one example used everywhere

The UI placeholders, the "Use example" / "Pakai contoh" buttons, and
this document all use the same button set, so what you read here is
what you will see in the builder:

- **Message text:** `Halo! Mau lihat apa dulu?`
- **Buttons:**

| # | Type | Title (visitor sees this) | Payload (sent back on tap) | URL |
|---|------|---------------------------|----------------------------|-----|
| 1 | reply | `Lihat Harga` | `HARGA` | - |
| 2 | reply | `Cek Jadwal` | `JADWAL` | - |
| 3 | url | `Kunjungi Website` | - | `https://example.com` |

As JSON (the block model in `packages/channels`, also what the API
persists on the message row's `payload` column):

```json
{
  "kind": "buttons",
  "text": "Halo! Mau lihat apa dulu?",
  "buttons": [
    { "type": "reply", "title": "Lihat Harga", "payload": "HARGA" },
    { "type": "reply", "title": "Cek Jadwal", "payload": "JADWAL" },
    { "type": "url", "title": "Kunjungi Website", "url": "https://example.com" }
  ]
}
```

### Title vs payload vs URL - the three fields, once

- **Title** is the label on the button: what the visitor reads and
  taps. Keep it short - channels truncate long labels.
- **Payload** is a code *you* choose (e.g. `HARGA`). The visitor never
  sees it. When the button is tapped, the payload is sent back to
  Botara, where a flow's **postback trigger** can match it (see the
  follow-up flow below). Think of it as the button's ID.
- **URL buttons** have no payload: tapping one just opens the link in
  the visitor's browser/app. Nothing comes back to Botara.

## What each channel renders

| Channel | Buttons block | List block |
|---------|---------------|------------|
| WhatsApp | Interactive reply buttons (max 3) + CTA-URL button | Interactive list message (button label + sections/rows) |
| Telegram | Inline keyboard under the message | Inline keyboard (one button per row) |
| Messenger | Button template (postback + web_url buttons) | Quick replies / text fallback per content limits |
| Instagram | Quick replies (reply/postback) + generic template for URL mixes | Quick replies (rows flattened) |
| Webchat (Botara widget) | **Clickable buttons under the bubble**, rendered natively by the widget | Message text, then each section's rows as clickable buttons (row description shown smaller beneath the title) |
| Email / Threads / others | Formatted plain text + `RICH_DEGRADED_TO_TEXT` warning | Same |

Carousel, product and catalog blocks render natively where the channel
supports them (WhatsApp product/catalog messages, Messenger generic
templates, …) and degrade to text elsewhere - in the webchat widget
they always degrade to text; only buttons and lists are clickable
there.

## The click round-trip

1. Your flow (or an agent in the inbox) sends the buttons block. The
   block is persisted on the message row (`messages.payload`), so the
   widget can render the buttons and the inbox thread can show agents
   read-only chips of exactly what the visitor saw.
2. The visitor taps **Lihat Harga** in the widget. The widget posts
   `{ "text": "Lihat Harga", "buttonPayload": "HARGA" }` to the public
   webchat API; the tap appears in the thread as a normal visitor
   message with the title as its body and `{ "buttonPayload": "HARGA" }`
   stored on its payload. The button set then disables itself
   (one-shot) so a double-tap cannot fire the follow-up twice.
3. Botara matches flows against the tap: **postback triggers** test
   the payload (`HARGA`); **keyword triggers** test the title text
   (`Lihat Harga`). So a click can start a flow either way - on other
   channels the same applies to native button taps (WhatsApp/Telegram/
   Messenger postbacks arrive as postback events with the payload).
4. The matched flow runs as usual: its first `send_message` node is
   the reply the visitor sees next.

## Follow-up flow example: HARGA -> price list

To answer the "Lihat Harga" tap with a price list, create a second
flow:

1. **Trigger:** type `postback`, payload `HARGA` (match: equals).
2. **Node 1 - `send_message`:** text
   `Harga paket: Basic Rp99rb/bln, Pro Rp199rb/bln. Mau dibantu pilih?`
3. Save and activate the flow.

Now the full loop works end to end: the first flow (or an agent) sends
"Halo! Mau lihat apa dulu?" with the three buttons; a tap on
**Lihat Harga** fires this flow and the visitor receives the price
list; a tap on **Cek Jadwal** does nothing until you add a sibling flow
with postback payload `JADWAL`; **Kunjungi Website** simply opens
`https://example.com`.

Tip: because keyword triggers also match the button *title*, a flow
with keyword trigger `harga` would fire on the same tap (the title
"Lihat Harga" contains it) - pick one matching style per button to
keep behaviour obvious.
