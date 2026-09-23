# Clio Coder GUI design

This is the design authority for `apps/clio-coder-gui`. Where this document and the code disagree,
one of them is a bug; `scripts/check-contrast.mjs` exists so that the colour half of the disagreement
cannot happen silently.

## What this is

The Clio Coder GUI is a field observatory for code: a calm scientific instrument wrapped around a
real Clio Coder process. It helps scientists, researchers and domain experts describe an outcome,
observe work, make consequential decisions, and inspect the evidence without first learning an IDE
or a terminal vocabulary. It should feel like a field notebook joined to a calibrated instrument.

It must not feel like a terminal emulator, a fictional mission-control dashboard, a generic chat
application, or a second implementation of Clio Coder. Those four negations are the review test when
a new surface is proposed.

**Naming.** The product name shown to people is **Clio Coder**. "GUI" and "desktop app" are
descriptions, used only where the interface must distinguish its own local observations or settings
from Clio Coder's authoritative state. Bare "Clio" is not a product alias: prose, status and
provenance labels, accessible names, errors and diagnostics all say Clio Coder, because this
application must not be confused with `clio-agent`, `clio-core` or `clio-kit`. Exact compatibility
identifiers stay unchanged: the `clio-coder` executable, protocol enum values, persisted keys and
internal type names.

**Interaction language.** Prefer "project", "question", "working freedom", "evidence", "outcome",
"earlier record", "choose a folder". Keep the precise Clio Coder terms where changing them would
hide scope: "target", "model", "session", "turn", "ACP". The composer's primary action is never
"execute"; the operator *sends a request* and Clio Coder decides which permitted tools apply.
State timing beside configuration: routing reaches the next turn, default autonomy reaches the next
session, and a bound session retains the autonomy Clio Coder reports it is enforcing.

## Colour roles

The source of truth is `client/design/tokens.css`. That file says what each token *is*; this table
says what it *means*. No other stylesheet may introduce a raw hex, because a raw hex cannot follow
the theme.

| Role | Token group | Meaning |
| --- | --- | --- |
| Paper and surfaces | `--paper`, `--surface`, `--surface-sunken`, `--overlay` | Background depth and structural hierarchy |
| Notebook ink | `--ink`, `--ink-strong` | Readable content and headings |
| Quiet annotation | `--ink-muted`, `--ink-subtle` | Supporting copy and metadata |
| Sage green | `--accent`, `--accent-strong`, `--accent-soft`, `--on-accent` | Interaction, connection, observation |
| Amber | `--action-fg/tint/line` | Consequential action, active work, pending approval |
| Green | `--status-success-*` | Explicitly completed or healthy facts only |
| Amber-gold | `--status-warn-*` | Waiting, uncertainty, pending scope, degraded state |
| Brick | `--status-fail-*` | Failure and destructive action |
| Slate blue | `--status-running-*` | Tool observation and neutral live information |
| Violet | `--reason-*` | Clio Coder-reported reasoning or narrative provenance |
| Slate grey, dashed | `--status-unverified-*` | No probe has run; unavailable; not measured |
| Rules | `--line` decorative, `--line-strong` control boundary | Structure |
| Contained code | `--code-paper`, `--code-surface`, `--code-ink`, `--code-ink-muted`, `--code-line`, `--code-gutter` | Code and diagrams, dark in both themes |

**Colour is always supplementary.** Text, label, shape or pattern must carry the same distinction.
That is why `StatusMark` always renders a glyph and a word, why `unverified` is dashed, and why a run
row that failed says `FAILED` rather than merely being red.

Light is warm cream paper with sage-green ink; dark is muted forest with pastel sage. The `--code-*`
group is deliberately dark in both themes. An explicit theme choice persists in
`clio-coder-gui-theme` and wins over the system preference in both directions; without a choice, the
`prefers-color-scheme` block in `tokens.css` paints the correct theme on the first frame.

The accent hue is sage green, and it is not teal. The retired `apps/workbench` palette was
graphite and teal on a dark-only shell; the ten colour *roles* were ported and the hues were not.

## Type

Three faces, three jobs, no overlap.

- **Atkinson Hyperlegible Next** is the interface and reading face and the default, chosen because
  legibility matters more than fashionable neutrality.
- **Newsreader** marks research questions, notebook headings, outcomes and major wayfinding. Use it
  selectively, so the interface keeps a field-note character rather than becoming a magazine.
- **Commit Mono** is reserved for paths, exact keys, timestamps, measurements, compact labels and
  machine-attributed values. It is never the conversation voice.

Fonts are local `@fontsource` package assets, never a CDN link; the CSP is `font-src 'self'`. The
fallback stacks in `--font-ui`, `--font-editorial` and `--font-mono` are real and are what a reader
sees before the font files resolve: Segoe UI / system-ui, Georgia, and Cascadia Code / Consolas.
`:root` carries `font-synthesis: none` so a missing weight is never faked into mush.

Banned: Inter, monospaced body copy, terminal prompts, all-caps paragraphs. Uppercase is limited to
short instrument labels (`.eyebrow`, `.status-mark`) on inspector pages. The conversation speaks in
sentence case throughout: its status marks, activity kinds and outcome line are a glyph and a word
in the interface face, because the reading voice is not an instrument panel.

Scale: `--text-body` 15px and `--text-reading` 16px for reading, `--text-meta` 13px, `--text-exact`
12px for mono keys, ids, timestamps and counts. `--text-instrument` 10px is allowed **only** for an
uppercase eyebrow of a few words, never for a sentence. Nothing renders below 12px except that
eyebrow.

Variable-font axes are what make the editorial face read as editorial and are easy to lose in a
port: `"opsz" 28, "wght" 580` for display, `"opsz" 22, "wght" 550` for headings, `"opsz" 20,
"wght" 480` for a prompt.

**Numbers.** Every rendered count, duration, token figure, cost and byte size uses `--font-mono` with
`font-variant-numeric: tabular-nums`. This is a performance rule as much as a typographic one:
proportional digits reflow a whole table on every tick of a live run.

## Density and shape

Generous space around primary work; denser bounded material behind disclosures and at the rails.
Panels use fine hairlines and shallow radii. Rounded cards are instruments or notes, not floating
consumer-app bubbles.

Three density zones:

- **Reading** (conversation, docs, page intros): `--space-6` block rhythm, `--text-reading` with
  `--leading-reading`, `--reading-measure` for prose, `--conversation-max` for the spine.
- **Instrument** (trace panels, receipt grids, settings, home cards): `--space-4` gaps,
  `--text-body`, `--leading-body`.
- **Dense** (tables, event lists, JSON wells, activity groups, rail items): `--space-2` and
  `--space-3`, `--text-exact` in `--font-mono`, tabular numerals throughout.

**Page frame.** Most pages use `main` padding `--space-12 --space-12 --space-16` at desktop,
`--space-8 --space-6` below 1050px, `--space-6 --space-5` below 650px, inside a `main` capped at
1440px. The conversation is the exception and fills the whole pane: `main` is neither capped nor
padded, the header spans the pane, and the transcript is the one scroller, with its scrollbar at the
pane's edge and `scrollbar-gutter: stable both-edges`. The transcript content, the approval region
and the composer share one centred column, `--conversation-max` (820px, about 90 characters) plus a
`--chat-gutter` of `--space-8`, `--space-6` below 1050px and `--space-4` below 650px. A capped `main`
or a capped conversation box leaves dead space beside the window and draws a scrollbar in the middle
of the page; that was an observed bug. The document itself reserves no scrollbar gutter on this page
because it never scrolls. Permission review, a long pending-message queue, and the explicit
session-tools disclosure may scroll locally when their content exceeds the available space. Session
tools open on demand, not as a stack of permanent cards above the transcript. The minimum side gutter
at any width is `--space-4`.

**Radius decision rule.** `--radius-xs` for inline chips in dense rows and for JSON wells;
`--radius-sm` for controls (button, input, select, badge); `--radius-md` for panels, cards, and the
code blocks and diagrams in reading text;
`--radius-lg` for dialogs, drawers, the composer and the operator's request; `--radius-pill` only for
status marks on inspector pages and the jump pill. Nothing gets a radius the tokens do not name.

**Elevation decision rule.** `--shadow-none` is the default for every card, table and panel; the
boundary comes from `--line-strong`, not from a shadow. `--shadow-raised` is for a sticky masthead
once the page has scrolled, `--shadow-panel` for drawers and the toast stack, `--shadow-float` for
modal dialogs. A card does not lift on hover.

**Layout.** Dense bounded material at the `--rail-width` rail, a wider notebook in the centre. Main
content uses `minmax(0, 1fr)` tracks; tables, code and diagrams scroll inside their own
`overflow-x: auto` surfaces so the page body never scrolls horizontally.

**Texture.** A faint measurement grid or reticle may establish place, but decorative telemetry must
never imply data. No fake sparklines, no ambient counters, no decorative numbering in navigation.

## Status

`client/design/status.tsx` owns the ramp. The truthfulness contract needs nine distinct states, and
they collapse onto six tones where the tone never carries the meaning alone.

| Tone | Means | Glyph | Typical labels |
| --- | --- | --- | --- |
| `neutral` | Reported, no judgement | `·` | REPORTED, QUEUED, SKIPPED |
| `running` | In flight, observed live | `▸` | RUNNING, STREAMING, PROBING |
| `success` | Explicitly completed or measured healthy | `●` | COMPLETED, HEALTHY, VERIFIED |
| `warn` | Waiting, degraded, estimated, pending scope | `◐` | WAITING, ESTIMATED, DEGRADED, TRUNCATED |
| `fail` | Failed or stopped | `✕` | FAILED, CANCELLED, STOPPED |
| `unverified` | No probe has run; not zero, not success | `◌` | UNAVAILABLE, UNVERIFIED, NOT MEASURED |

`unverified` renders with a **dashed** rule, which is what makes "missing evidence is not success"
visible in a greyscale screenshot.

`--reason-*` (violet) marks Clio Coder-reported reasoning or narrative provenance and `--action-*`
(amber) marks consequential action and pending approval. Neither is a status tone; do not merge them
into the ramp.

## Motion

Short entrance and state-change transitions, only when they clarify hierarchy or causality. No
continuous pulse, no blinking cursor, no animated waveform, no ambient dashboard motion. A streaming
response does not animate; text appearing at the display's cadence *is* the animation.

Four durations and two curves, in `tokens.css`: `--motion-fast` 120ms for colour, border and
background state changes; `--motion-base` 150ms for disclosure and hover displacement;
`--motion-slow` 180ms with `--ease-emphasis` for the two things that travel a distance, drawers and
dialogs; `--motion-instant` 90ms for an immediate acknowledgement. Nothing else animates.

`client/design/a11y.css` collapses every transition and neutralises `animation-iteration-count`
under `prefers-reduced-motion: reduce`, so an infinite animation cannot survive the preference.

Collapsing a rail removes its grid track immediately and restores focus predictably when reopened.
It does not run a full-shell animated reflow while text is streaming.

## Focus and non-text contrast

**The floor is 4.5:1 for text and 3:1 for non-text boundaries and focus indicators** (WCAG 2.2
SC 1.4.3 and SC 1.4.11). `scripts/check-contrast.mjs` parses the token values and asserts 92 pairs
across both themes; it fails the build rather than warning.

The focus ring is two-tone, in `client/design/a11y.css`: a 2px `outline` in `--focus` at a 2px
offset, over a 2px `--focus-halo` box-shadow. The outline carries the indicator and survives forced
colours, which a box-shadow does not; the halo repaints the local background so the outline's 3:1
holds whatever the control sits on. On a filled accent control the ring flips to `--on-accent` over
`--accent-strong` so it does not blend into the fill. Light `--focus` measures 7.98:1 on paper and
7.20:1 on the sunken well; dark measures 9.65:1 on paper.

`--line` is decorative and may never be the sole boundary of an interactive control; it measures
around 1.3:1 by design. `--line-strong` is the boundary of every button, input, select, textarea,
count, badge, panel, permission card, session control and table cell, and measures 3.13:1 to 3.69:1
in light and 3.26:1 to 4.08:1 in dark. The mechanical rule: **if removing the border would make the
control's hit area ambiguous, it is `--line-strong`.** The one relaxation is a control whose own
words name it in a quiet row: Session tools in the conversation header, the copy and retry actions
under a message, and the copy and source actions in a code block's head. These stay frameless until
hovered, focused or open, and keep the focus ring.

Under `forced-colors: active` every box-shadow is dropped, the ring becomes `2px solid Highlight`,
and only the few marks whose shape is the information keep `forced-color-adjust: none`.

`@media (prefers-contrast: more)` darkens `--line`, `--line-strong`, `--ink-muted` and `--ink-subtle`
in both themes.

## The conversation record

A turn reads as one record: the operator's request, Clio Coder's prose with its activity folded
between paragraphs, and one outcome line. Place and ground tell the two voices apart, so there is no
rail, avatar, eyebrow or card around a response. The Conversation and the Session Timeline are two
projections of the same array, a view switch over the same scroll region and never a second shell;
neither may show an item the other lacks.

1. One turn is every item sharing a `turnId`.
2. The request is the operator's own text, right-aligned, `max-width: min(80%, 40rem)`, on
   `--surface-sunken` with `--radius-lg`, in the interface face and never reinterpreted as Markdown.
   Who wrote it is announced to assistive technology rather than printed. Its time and Copy prompt
   sit under it and surface on hover or focus, and always on a touch screen. A replayed request keeps
   its visible "earlier record" chip.
3. The response is unboxed prose on the page ground. Clio Coder is the default voice, so its name is
   announced rather than printed; a delegated worker is named on screen, and a live turn shows the
   live chip. Response headings use the interface face at reading sizes (22, 19, 17px).
4. Tool, approval and loop items falling between two stretches of prose collapse into one
   `<details>` activity group. Its `<summary>` is a quiet line with no frame: a glyph, a count label
   ("6 tools completed", "1 tool running · 2 done", "1 step failed") and a digest of what the group
   did ("listed 2 folders, ran 1 search, read 3 files"). Only a group waiting on the operator is
   drawn as more than a line. The group opens itself while attention is needed and then stays exactly
   as the operator left it. Opened, each call is one folded row: glyph, plain verb, target, one fact
   (exit code, line count, `+7 −1`). A change keeps its diff open; a failure carries its last output
   line; a change that was not approved keeps the proposal on screen, labelled "Not applied · not
   approved", because the runtime words a denial, a cancelled turn and an abort alike. The digest
   says "changed" only for a change that completed without an error.
5. The approval is one decision with two surfaces. The anchored card beside the call carries the
   review: what is asked, the proposal, the facts, Reject and Allow once. While that card is on the
   page, the pinned banner above the transcript is a one-line strip: what is asked, the time left,
   Review (which brings the card into view), and the same two buttons. When the call is not in the
   timeline or its group is folded, the banner carries the full card instead. The banner owns the
   announcement and the keyboard chords either way.
6. Reported reasoning lives behind a disclosure, tinted `--reason-*`, never inline with prose.
7. One quiet line closes the turn: the outcome as a glyph and a word, the tool count, input and
   output tokens with the complete accounting behind a disclosure, the finish time, and the
   response's own actions at the right. No rule above it and no pill.
8. Agent identity is always Clio Coder. If the protocol carries no sub-agent fact, the surface
   reports which agent is active as *unavailable* rather than inferring it.

**Render budget.** Settled turns are memoized by turn object identity and skip re-rendering
entirely; only the live turn re-renders on a clock tick, phase change or permission change. Use
`contain: layout style` on the turn element, **not** `content-visibility: auto`: the latter collapses
scroll height for a frame when it toggles, and the follow rule reads that collapse as the end of the
transcript. That is an observed bug, not a preference.

## Follow-latest

The transcript follows new output while the operator is at the end. Four clauses, all load-bearing:

1. A scroll event counts as the operator's only when it moves above the last programmatic position,
   or when the view was already not following. Growth between a programmatic pin and the scroll event
   it produces must never read as scroll-away. Keep `lastProgrammaticTop` in a ref and return early
   from the handler while `following && el.scrollTop >= lastProgrammaticTop.current - 1`.
2. Scrolling back to the end resumes following, at a threshold of
   `scrollHeight - scrollTop - clientHeight <= 24`.
3. Each view remembers its own offset and follow state, and restoring one never counts as a scroll:
   set `lastProgrammaticTop` before the restoring assignment.
4. The jump pill sits above the composer and reads "Jump to latest", or "New activity below" in
   `--action-fg` when timeline *items* arrived while scrolled away. Gate that flag on item arrival,
   never on a `scrollHeight` change, so lazy highlighting or a growing diagram cannot claim activity.

Do not force `scroll-behavior: smooth` on the transcript; it fights the pin and costs frames. Pin
with `el.scrollTop = el.scrollHeight` inside the same rAF callback that delivers the batch.

## Streaming cadence

1. Project narrative and reasoning at the browser's display cadence: batch only those
   high-frequency deltas with `requestAnimationFrame`, retain wire order, and cap each buffered
   batch at `MAX_FRAME_EVENT_BATCH = 128`.
2. Tool, approval, terminal, control and error events remain immediate and flush any preceding
   narrative first, in the same ordered delivery.
3. Keep the composer's draft and scroll position inside an isolated component so incoming agent
   frames never reconcile the operator's keystrokes.
4. Prefer native scrolling with `scrollbar-gutter: stable` and local `contain: layout style` on long
   text surfaces. Do not force smooth scrolling, do not continuously measure geometry, and never put
   `backdrop-filter` or another expensive effect over moving text.
5. Memoize settled evidence cards and settled turns. Only the active card or turn may carry a ticking
   duration; high-frequency state must not invalidate the rail, the composer or completed history.
6. Treat 120 Hz and higher as a first-class target: preserve input responsiveness and coalesce work
   to paints. Never add an artificial timer merely to make streaming look animated. Because the work
   is coalesced to `requestAnimationFrame`, the surface already runs at whatever the display does;
   there is no 60 Hz constant to raise.
7. **Never restate a display rate that was not measured.** The reference budgets below came from a
   60 Hz headless compositor and bound per-frame work; they do not demonstrate 120 Hz behaviour. This
   app's own numbers belong in `PERFORMANCE.md` with the exact workload that produced them.

Reference budgets to beat, measured on `apps/workbench` at 60 Hz headless over ~16 KB of Markdown
streamed in 5-char chunks: keystroke→`input` p95 2-3 ms; keystroke→next frame p95 15-19 ms;
event→paint p50 25-27 ms and p95 33-35 ms; zero tasks over 50 ms during the stream. At 120 Hz the
frame budget halves to 8.3 ms, so the target is keystroke→next frame p95 under 10 ms.

## Untrusted Markdown, code and diagrams

The GFM lexer produces tokens and React creates their text nodes and elements. Raw HTML remains
visible text. Images are represented by their alt text without fetching. Only `http`, `https` and
`mailto` links are live; other destinations remain inert.

Streaming re-lexes only the tail after the last settled block boundary, a blank line *outside* a
fence, so settled blocks keep token identity; completion re-lexes once with the same element shape so
settled blocks stay mounted.

Prism loads its core and known grammars on demand, only for settled blocks near the viewport and at
most 60,000 characters. Its output is a token tree, never HTML. Unknown languages render plain with
their label shown. Copy is explicit, and an overflowing `<pre>` accepts focus for keyboard scrolling.

A code block or diagram is one dark well with `--radius-md` and a `--code-line` hairline. Its chrome
is a single quiet head inside the well, with no ground or rule of its own: the language in
`--text-exact` mono and `--code-ink-muted`, then the actions (Copy; Show source and Copy source on a
diagram) as frameless words that take `--code-surface` on hover. A block names its line count only
once it is longer than the 24 lines its `<pre>` shows before scrolling, because a block that fits
already shows its length. The conversation and Docs share this one treatment. Mermaid's theme
variables restate the `--code-*` tokens in hex, because Mermaid computes shades from them: node fills
on `--code-surface`, sage rules that clear 3:1 on `--code-paper`, and `--code-ink` labels.

Mermaid loads after the response settles. Bounds are three numbers, not two: **16 KiB and 400 lines**
of source, and **400 edges** at the renderer. Layout is one synchronous main-thread task, which is
why diagrams render one at a time with a macrotask between them; without that, a two-diagram turn
produced a 76 ms task during streaming. Configure `securityLevel: "strict"` and `htmlLabels: false`.
The DOMPurify SVG profile explicitly forbids `foreignObject`, `a`, `image`, `script`, all animation
elements, and `href` and `on*` attributes; changing that list is visibly a policy change. A failed or
oversized diagram keeps its source and the parser's message visible, never a blank box.

**CSP justification.** The page allows `style-src 'self' 'unsafe-inline'` *solely* because strict
Mermaid output carries its theme in an embedded stylesheet and inline attributes. Scripts stay
same-origin, and `img-src`, `font-src` and `connect-src` still block CSS-driven fetches. No other
code path renders model-authored markup.

## Component sources

One design language even when primitives come from several source-available libraries. Copy only the
component source needed for a concrete product surface, adapt it to these tokens and semantics, and
keep the result local and testable. **Do not add a component library as a runtime dependency.**

Preferred sources, in order:

1. **shadcn/ui** (MIT) — durable primitives, forms, dialogs, command surfaces, sidebars,
   accessibility patterns.
2. **Kibo UI** (MIT) — data-heavy views: bounded tree, code presentation, lists, tables, status,
   Kanban, and a Gantt-like run view when the real protocol supplies the necessary facts.
3. **Agent Elements by 21st.dev** (MIT) — agent/tool, plan, question, MCP and subagent presentation.
   Treat as a younger source: inspect the code, remove runtime assumptions, add tests.
4. **Blocks.so** (MIT) — onboarding, forms, command menus, file upload, statistics, responsive shell.
5. **Public ReUI repository components** (MIT) — only where the individual source file is present
   under the public repository's licence and fills a real gap.

Consult-only: **Vercel AI Elements** (Apache-2.0) for streaming conversation patterns. Its Next.js
and AI SDK coupling must not become a second runtime inside this Vite application.

**Hard prohibition:** do not copy premium **ReUI Pro or Ultimate** source into this repository. That
commercial licence does not permit publishing the licensed source as part of a public repository.

Before adopting any block, all seven must hold: verify the exact file and version's licence; remove
demo data and decorative metrics; map every colour, type, spacing, radius and motion value to these
tokens, so no adopted file contains a raw hex; replace developer vocabulary with domain-appropriate
language without weakening precision; preserve keyboard, focus, screen-reader, forced-colors,
reduced-motion and compact-layout behaviour; prove every displayed fact traces to a protocol field or
a clearly labelled local observation; and add unit and real-browser coverage for the state it
represents.

## Authority and truthfulness

1. Clio Coder remains authoritative for sessions, tools, routing, models, autonomy, permissions,
   context, agents, skills and outcomes. The GUI renders only facts exposed through its bounded
   protocol.
2. Every summary must say whether a fact was reported by Clio Coder, observed live, observed locally
   by the GUI, or replayed. Provenance is a rendered property, not a comment.
3. **Missing evidence is not success. Silence is not completion.** A target is not healthy until an
   explicit, timestamped probe says so.
4. Measured, estimated, reported, replayed, unavailable, failed, stopped and skipped are distinct
   states and must be distinguishable without colour.
5. A pending approval is never answered implicitly, and an unanswered approval is never presented as
   a rejection. Escalation means still waiting; budget expiry means the app cancelled the turn.
   Cancellation and failure remain distinct outcomes.
6. Internal identifiers, hidden reasoning, raw provider payloads, untrusted paths and speculative
   dependency graphs do not become presentation data.
7. The GUI may simplify vocabulary but must keep the exact underlying Clio Coder key reachable where
   that helps auditability. Canonical workspace paths and evidence identifiers stay reachable;
   credentials and provider bodies never become labels or summary text.
8. **Resource inventories enter the browser only through bounded projections.** Skill bodies, hashes,
   native locations, extension roots and manifests, source URLs, requirements and raw diagnostics
   stay host-side. **A formatted CLI table is not a typed fact source.**
9. Offline model and worker-routing inventories follow the same rule. Provider URLs, credentials,
   environment and raw warnings stay host-side, and cached residency is never presented as endpoint
   health.
10. Show problem details with their closed code and instance reference. Notifications persist until
    dismissed, and a small bounded stack prevents errors from filling the screen.
11. Historical views must distinguish a missing store from zero activity, and must not mix
    installation-wide records into a project-scoped canvas merely because an upstream report contains
    both.

**Design consequence to enforce in review:** any component that renders a number must be able to
render "not measured" in the same slot without a layout shift. If it cannot, it will eventually
render `0` for unknown.

## Shell and wayfinding

The persistent desktop rail contains Overview, Sessions, Traces, Toolchain, Docs, Settings, Fleet,
Evidence, Library and System, in two groups: the conversation pair, then Inspect & configure. The `--masthead-height` masthead carries the Clio logo, a
discreet connection indicator, and icon controls with accessible names. App preferences hold the
reported version, PWA installation and browser connection controls. There is no page footer; the
application gives that space to the work.

Below 750px the rail becomes a native modal `<dialog>`, so the browser owns focus containment,
Escape and return-to-trigger. A skip link reaches the main landmark. Route changes focus that
landmark and update the document title.

The conversation header is one bar across the pane: the project link, the title (the session label,
else the first request), the live status as a glyph and a sentence, the route (target and model,
with the target's reported health folded into its glyph), and one **Session tools** menu. The menu
holds the project path, switching, session controls, Clio Coder commands, dispatched workers and
Close session, and it hangs below its own button at every width. An unhealthy target, an
unrecognised health fact or a context warning is written out in full under the bar. Below 650px the
project link shrinks so the status and the menu share its line, and the title takes the next.

## Acceptance floor

Every UI change must preserve:

1. `pnpm run verify` in `apps/clio-coder-gui`: typecheck, biome, unit tests, build, and the contrast
   check.
2. The real browser smoke against an ACP fixture child, driving real handlers and workers at 1600,
   1050 and 390px.
3. Zero serious or critical Axe violations in the covered states.
4. No horizontal overflow at 375px.
5. Visible focus in forced colors.
6. Contained and restored focus for dialogs and drawers; below 750px the rail is a native `<dialog>`
   so the browser owns containment, Escape and return-to-trigger.
7. Meaningful loading, empty, unavailable, truncated, replayed, failed, waiting and stopped states
   without relying on animation or colour. This is the clause that catches most regressions: a
   component with only a happy path fails here.
8. No unexpected error responses, script exceptions or request failures during the smoke.
9. No changes under the repository's `src/` as part of GUI-only design work.
10. Screenshots inspected before being retained as slice evidence.

Covered states the smoke must visit: home in both themes, toolchain, traces and run detail,
workspaces and sessions, a Markdown/code/Mermaid conversation, session controls, permission and
cancellation, and a problem notification. This design work adds three: the six status tones rendered
side by side, a focus-visible capture of a button, an input and a table cell, and one forced-colors
pass.

**Documented exception, kept narrow:** a noninteractive `<pre>` must be focusable because it scrolls
horizontally. Axe plus an ArrowRight browser check verify the reason. No accessibility rule is
disabled globally.
