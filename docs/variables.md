# Message & system variables

Botara message texts are personalized with `{{path}}` variables that
render **at send time, per recipient**, on every send surface (flows,
sequences, broadcasts, inbox replies). Before this package (combined
adoption #1), all Botara texts were static.

The engine is one pure function — `interpolate(template, context)` in
`packages/shared/src/variables.ts` — plus `buildVariableContext(...)`
which shapes contact / workspace / channel-account rows into the
context. Every surface imports the same engine, so semantics never
drift between a flow, a broadcast, and a manual reply.

## Syntax

```
Halo {{contact.name}}, pesananmu sudah dikirim!
```

- Dot paths: `{{contact.address.city}}` walks nested objects.
- Whitespace inside the braces is tolerated: `{{ contact.name }}`.
- There is **no escaping mechanism in v1**: a literal `{{` in authored
  text is always treated as a variable opener. An unclosed `{{` (no
  matching `}}`) is left untouched.

## Variable catalogue

| Variable | Resolves to |
|---|---|
| `{{contact.name}}` | Contact display name; falls back to the external id when the contact has no name |
| `{{contact.externalId}}` | The contact's id on its channel (phone number, chat id, …) |
| `{{contact.channel}}` | The contact's channel key (`whatsapp`, `telegram`, …) |
| `{{contact.tags}}` | The contact's tags joined with `", "` |
| `{{contact.<customFieldKey>}}` | Any contact custom field. Reserved keys above win over a custom field of the same name; deeper paths walk nested objects (`{{contact.address.city}}`) |
| `{{workspace.name}}` | The workspace's name |
| `{{channel.name}}` | The sending channel account's display name (falls back to the platform key) |
| `{{channel.platform}}` | The sending channel's platform key |
| `{{vars.<name>}}` | The flow-run variable bag — see below. Only exists inside flow runs |
| `{{system.date}}` | Current date, `YYYY-MM-DD` |
| `{{system.time}}` | Current time, `HH:MM` (24h) |
| `{{system.now}}` | Current timestamp, full ISO 8601 |

### The `vars` bag (flows only)

Flow runs already carried a variable bag before this package: the
trigger event's variables (contact custom fields the dispatcher /
loader merged in, plus `messageText`) live on the run state, and the
interpreter substituted flat `{{key}}` tokens from it. The new engine
exposes that same bag under the `vars.` root:

- `{{vars.messageText}}` — the message that triggered the run.
- `{{vars.<customFieldKey>}}` — contact custom fields also resolve here
  (they are merged into the run), in addition to `{{contact.<key>}}`.
- Run-start values win: the executor merges the caller's context vars
  under the run's current variables at every step.

`set_field` still writes **contact custom fields** (persisted), not the
run bag — a value written by `set_field` is readable as
`{{contact.<field>}}` in later runs, not as `{{vars.<field>}}` in the
same run. A dedicated collect-input step is package #3 of the adoption
program.

## Semantics

- **Unknown / unresolvable → empty string + warning.** A variable whose
  root is absent (e.g. `{{vars.x}}` outside a flow), whose key does not
  exist, or whose value is `null` renders as an empty string and adds
  an `UNKNOWN_VARIABLE` warning carrying the path. Warnings are logged
  by the worker and returned by the API where the surface supports it
  (the inbox reply returns `interpolationWarnings`; the flow test-run
  returns `warnings`). **A raw `{{...}}` token never reaches a
  customer.**
- **Interpolation never throws.** A context lookup that fails degrades
  to fewer resolvable variables, never to a blocked send.
- **Stringification:** strings pass through; numbers and booleans use
  their plain form (`3`, `true`); arrays join with `", "`; objects
  render as JSON.
- **No variables → byte-identical.** A text without `{{` is sent
  exactly as authored, with zero warnings.

## Timezone limitation

`{{system.*}}` is evaluated in **UTC**. Workspaces do not store a
timezone yet; a workspace-timezone field (and local-time rendering)
arrives with the analytics package (#8). Until then, schedule-sensitive
copy should avoid implying local time.

## Per-surface behavior

| Surface | What renders | Notes |
|---|---|---|
| Flow `send_message` nodes | Text + rich-block text fields (text, button titles, list labels, carousel titles/subtitles) | Rendered by the flow executor in the worker; ids, payloads, and URLs are never interpolated. AI-reply **output is never interpolated** (it is generated text); the node's authored `fallbackText` is |
| Sequence steps | Text steps; template steps' `templateParams` | Rendered in the worker sequence processor against the enrolled contact |
| Broadcasts | `templateParams` (below) | One mechanism: an ordered array of param templates |
| Inbox manual replies | Free-form text + rich blocks | Rendered in the API reply path against the conversation's contact; the **rendered** text is what gets persisted and shown in the thread. AI-suggest output is **not** interpolated (it fills the draft; if the agent sends it unchanged and it happens to contain a token, the reply path renders it like any agent text — the suggestion itself is generated verbatim) |

Every authoring surface offers the same variable-insert picker
("{x} Variable" button): inbox composer, broadcast form, sequence step
editor, and the flow builder (message text + rich block text). On
non-flow surfaces the `vars.*` group is hidden — it only exists inside
flow runs.

## Broadcast template parameters (worked example)

Template broadcasts send a provider template whose body has positional
placeholders (`{{1}}`, `{{2}}`, … on Meta's side). Botara templates are
stored as name/language/category only — there is deliberately **no
parameter schema**, so Botara does not validate a parameter count: the
values pass through to Meta, and a mismatch surfaces as a per-recipient
provider error in the send processor, exactly like other template
errors.

`POST /broadcasts` accepts an ordered `templateParams` array; each
entry is a literal/variable string interpolated **per recipient**:

```jsonc
// POST /broadcasts
{
  "channelAccountId": "…",
  "templateId": "…",
  "templateParams": ["{{contact.name}}", "{{contact.city}}"],
  "tag": "vip"
}
```

For a recipient named *Sari* in *Depok*, the worker renders the params
to `["Sari", "Depok"]` and the send job carries them as the template's
body components:

```jsonc
[{ "type": "body", "parameters": [
  { "type": "text", "text": "Sari" },
  { "type": "text", "text": "Depok" }
]}]
```

So a template body like *"Halo {{1}}, ada promo khusus untuk pelanggan
di {{2}}!"* arrives personalized for every recipient. Sequence
template steps accept the same `templateParams` inside their
`template` object, rendered the same way for the enrolled contact.

`templateParams` without a `templateId` is rejected with a typed
`400 VALIDATION` — parameters only make sense as a template's body
components. The broadcast form in the dashboard shows the parameter
rows (with `{{1}}`, `{{2}}`, … position labels and the variable
picker) once a template is selected; blank rows block creation because
positions cannot be skipped.
