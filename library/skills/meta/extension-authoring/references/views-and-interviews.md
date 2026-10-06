# Views, workspaces, skins and interviews

Return `ExtensionOutputV2` with `text` and declared drawing fields. `text` is the
headless fallback (up to 32768 characters); include a card for a visible command
reply when other drawing fields are present. Views are bounded plain data. Clio
owns framing, scrolling, focus, Escape and key routing; supply no ANSI or colors.
Unknown fields and invalid views fail validation as a whole.

| `t` | Shape and main bounds |
| --- | --- |
| `box` | `children`, optional `dir`, `gap`, `pad`, `border`, `title`, `meta`, `grow`, `width` |
| `text` | `text` ≤2000 characters; optional `tone`, `bold`, `dim`, `wrap`, `align` |
| `markdown` | `text` ≤8000 characters |
| `kv` | `items: [{label, value, tone?}]`, ≤32 |
| `table` | `columns` ≤8, `rows` ≤100; optional `keys`, `action`. Cells are strings, `{text,tone?}` or `{value,max,tone?}`. Each row matches column count; keys match rows. |
| `list` | `items: [{key,label,detail?,mark?,tone?}]` ≤100; optional `action` |
| `steps` | `items: [{label,state}]` ≤12; states `done|active|todo|blocked` |
| `board` | `columns: [{title,tone?,cards}]` ≤8, ≤60 cards total; cards `{key,title,detail?,badges?,tone?}`, ≤4 badges each; optional `action` |
| `tree` | `nodes: [{key,label,detail?,tone?,children?}]`, ≤200 total; optional `action` |
| `progress` | `value`, `max`, optional `label`, `tone` |
| `spark` | `values` ≤64, optional `tone` |
| `badge` | `text`, optional `tone` |
| `actions` | `items: [{id,label,hotkey?,primary?}]` ≤6; hotkey one lowercase letter or digit |
| `art` | `lines` ≤12, each ≤120 code points, optional `tone`; fixed-width, unwrapped |
| `divider` | No additional fields |
| `spacer` | Optional `size` ≤4 |

Root depth is 1; maximum depth 6, total 400 view/tree nodes. Labels ≤120
characters. IDs and keys must be nonempty; island keys unique. Clamp and summarize
large data before returning it. View tones: `neutral`, `muted`, `accent`, `brand`,
`positive`, `warning`, `error`, `info`. Status and toast accept only `neutral`,
`positive`, `warning`, `error`; the theme maps roles to actual colors.

Surface constants give conservative authoring budgets. The current TUI has its
own rendering caps; the distinction matters when designing larger workspaces.

| Surface | Published constant | Current TUI rendering |
| --- | --- | --- |
| Status / toast | 160 / 200 characters | Validated at these bounds |
| Band / card | 3 / 24 rows | Band 3; card 22 body rows plus frame |
| Workspace header | 6 rows | Up to 12 rows |
| Board placed as band / island | 12 rows / 48 columns | Band 14 rows; island 48 outer columns, 12 body rows |
| Rail | 40 columns | One line fitted to the available width |
| Floating islands | 4, each 48 columns × 10 rows | At most 4 accepted; 48 outer columns, 12 body rows; the whole floating stack is clipped to 28 rows |
| Footer | 2 rows | One line; design for one |

A command/action may return `workspace: {enter: "declared-id"}` or `{leave: true}`.
Regions and islands draw only while that extension's workspace is active.
`panel: {title, view}` can open from a command/action; an observation may update an
already open panel. Dock updates are ambient; its first opening is host-gated to
commands/actions. Observations cannot change workspace, start an interview or
fill/submit the prompt. Actions are registered with `api.action(id, handler)`;
selectable table/list/board/tree items send their key as `event.key`.

## Static workspace skins and leader bindings

A workspace's `skin` names a JSON file in the package. It may contain `palette`
with known palette names and `{dark: "#rrggbb", light: "#rrggbb"}` pairs,
`glyphs: {brand}`, and `agents: {recipeId: {label?, glyph?}}`. Brand/agent glyphs
are at most 2 code points; at most 32 agent entries, labels at most 24.

The host locks the palette entries derived from error, warning, success,
attention, attentionRail, yoloLabel and composerSurface roles, plus the yolo
composer command hint (`SKIN_LOCKED_PALETTE` in `skin-schema.ts`). At this head
they are `error`, `warning`, `success`, `orangeFocal`, `orangeReading`,
`orangeStrong`, `yoloSurface`, `orangeSupporting`. Never override those
safety/approval colors. Every override must meet contrast ≥4.5 in both
backgrounds: normally against the stock surface; `surface` against effective
neutralReading, `selectionSurface` against effective ivoryReading, `onAccent`
against effective cyanFocal. Validate the complete package to check the skin.
A skin is active only while that workspace is active and clears on leave/unload.

Workspace leader keys use the operator's configured leader (default Ctrl+G).
Free suffixes at this head: `c d f h j k v` and digits; `b` leaves the workspace.
Built-in and operator bindings win; colliding workspace bindings are disabled.
Register the named action; declaring a key without its handler fails registration.

## Interviews

Declare `ui: [interview]`, register `api.interview(id, handler)`, then return
`interview: {id, title, total?, step: {key, title?, intro?, questions}}` from a
command/action, or an `ExtensionToolResult` from a tool. The public tool contract
specifies parking until the operator finishes and answers becoming the tool result. At this head api 2 tool admission is not wired
into the live gateway; use commands/actions for live interviews and the public
kit for tool handlers (see the manifest reference). The intro is display-only; actions inside it cannot be pressed.

Each step has up to 4 questions and each choice question up to 12 options.
Questions have `{id,label,help?,kind,options?,initial?}`; kind `single|multi|text`,
options `{value,label,detail?}` with unique values and labels. `initial` is only a
draft: the operator must submit it. The handler receives
`{id,step,answers,nav,reason?}`; answers are strings or string arrays. Return the
next `{step,total?}`, or `{done:true,text,...}`. Store drafts in `ctx.state`.
Handle `nav: cancel` including reasons `operator`, `headless`, `preempted` without
performing the intended operation. `back` is reserved; the host does not send it.
