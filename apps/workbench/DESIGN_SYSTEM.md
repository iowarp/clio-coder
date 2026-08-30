# Clio Workbench design system

## Product thesis

Clio Workbench is a field observatory for code: a calm scientific instrument wrapped around one real Clio process. It
helps scientists, researchers, and domain experts describe an outcome, observe work, make consequential decisions, and
inspect the evidence without first learning an IDE or terminal vocabulary.

The interface should feel like a field notebook joined to a calibrated instrument. It must not feel like a terminal
emulator, a fictional mission-control dashboard, a generic chat application, or a second implementation of Clio.

The memorable visual element is the evidence spine. Requests, actions, approvals, narrative, and outcomes form one
legible record. A supplementary Observatory summarizes that same record without inventing facts.

## Authority and truthfulness

- Clio remains authoritative for sessions, tools, routing, models, autonomy, permissions, context, agents, skills, and
  outcomes. Workbench renders only facts exposed through its bounded protocol.
- UI summaries must say whether a fact was reported by Clio, observed live on ACP, observed locally by Workbench, or
  replayed by Clio.
- Missing evidence is not success. Silence is not completion. A target is not healthy until an explicit, timestamped
  probe says so.
- Measured, estimated, reported, replayed, unavailable, failed, stopped, and skipped are distinct states.
- A pending approval is never answered implicitly. An unanswered approval is never presented as a rejection.
- Internal identifiers, hidden reasoning, raw provider payloads, untrusted paths, and speculative dependency graphs do
  not become presentation data.
- Workbench may simplify vocabulary, but it must retain access to the exact underlying Clio key or fact where that is
  useful for auditability.
- Resource inventories enter the browser only through bounded projections. Skill bodies, hashes, native locations,
  source URLs, requirements, and raw diagnostics stay host-side; a formatted CLI table is not a typed fact source.

## Information architecture

The desktop shell has three complementary regions and one status strip:

1. **Project atlas** — projects, bounded files, and resumable conversations.
2. **Evidence notebook** — the human request, visible work, approval decisions, narrative, and outcome along a single
   evidence spine, followed by the composer.
3. **Observatory** — a compact view of current state, Clio-attributed routing, recorded-event counts, and provenance.
4. **Status strip** — connection, bound-session facts, next-turn differences, next-session differences, autonomy, and
   current operation.

On desktop, the Project atlas and Observatory must collapse independently. Collapsing either rail removes its layout
track immediately and restores focus predictably when reopened; it must not cause a full-shell animated reflow while
text is streaming.

The center notebook may switch in place to project-scoped analytical canvases such as Effective Clio and the Capability
atlas. These are alternate views of the same bounded workspace, not a second application shell or an invitation to add
global navigation. They retain a direct path back to the notebook and expose unavailable interfaces honestly.

Below 1180 px the Observatory becomes a contained drawer. Below 790 px the Project atlas becomes a contained drawer as
well. Both drawers must move focus into the panel, contain Tab, close with Escape or the scrim, restore focus to their
trigger, and make the obscured application inert.

Future research-team, changes, artifacts, context, budget, and skill views belong in these existing regions. Do not add
top-level navigation merely because a new event type appears.

## Visual language

### Color roles

The source of truth is the custom properties in `src/styles.css`.

| Role             | Token                       | Meaning                                                      |
| ---------------- | --------------------------- | ------------------------------------------------------------ |
| Instrument frame | `--graphite-*`              | Background depth and structural hierarchy                    |
| Notebook ink     | `--paper`, `--paper-strong` | Readable content and headings                                |
| Quiet annotation | `--muted`, `--dim`          | Supporting copy and metadata                                 |
| Teal             | `--accent`, `--accent-deep` | Interaction, connection, observation, and the evidence spine |
| Orange           | `--action`                  | Consequential action, active work, and approval              |
| Green            | `--success`                 | Explicitly completed or healthy facts only                   |
| Amber            | `--warning`                 | Waiting, uncertainty, pending scope, or degraded state       |
| Red              | `--error`                   | Failure and destructive action                               |
| Blue             | `--info`                    | Tool observation and neutral live information                |
| Violet           | `--reason`                  | Clio-reported reasoning or narrative provenance              |

Color is always supplementary. Text, labels, shape, or pattern must carry the same distinction.

### Typography

- **Atkinson Hyperlegible Next** is the interface and reading face. It is the default because legibility matters more
  than fashionable neutrality.
- **Newsreader** marks research questions, notebook headings, outcomes, and major wayfinding. Use it selectively so the
  interface retains an editorial field-note character.
- **Commit Mono** is reserved for paths, exact keys, timestamps, measurements, compact labels, and machine-attributed
  values. It is not the default conversation voice.
- Avoid Inter, monospaced body copy, terminal prompts, and all-caps paragraphs. Uppercase is limited to short instrument
  labels.
- Body copy should generally remain at or above 12 px, with primary reading text around 13–16 px.

### Shape, depth, and texture

- Panels use fine hairlines, shallow radii, and low-chroma graphite surfaces. Rounded cards are instruments or notes,
  not floating consumer-app bubbles.
- The faint measurement grid and reticles may establish place, but decorative telemetry must never imply data.
- Shadows express shell hierarchy, dialogs, and drawers. They do not make every card hover.
- Layout is intentionally asymmetrical: dense bounded material at the rails, a wider notebook in the center, and a
  narrow derived summary on the right.

### Motion

- Use short entrance and state-change transitions only when they clarify hierarchy or causality.
- No continuous pulse, blinking cursor, animated fake waveform, or ambient dashboard motion.
- Every transition must collapse under `prefers-reduced-motion`.

### Streaming and scroll performance

- Project narrative and visible reasoning at the browser's display cadence: batch only those high-frequency deltas with
  `requestAnimationFrame`, retain wire order, and cap each buffered batch. Tool, approval, terminal, control, and error
  events remain immediate and flush any preceding narrative first.
- Keep the request editor's draft and scroll position inside an isolated component so incoming agent frames do not
  reconcile the operator's keystrokes or textarea scroll.
- Prefer native scrolling with stable gutters and local layout/paint containment on long text surfaces. Do not force
  smooth scrolling, continuously measure geometry, or place backdrop filters and other expensive effects over moving
  text.
- Memoize settled evidence cards. Only the active card may receive a ticking duration, and high-frequency state must not
  invalidate the rails, composer, or completed history.
- Treat 120 Hz and higher displays as a first-class target: preserve input responsiveness and coalesce work to paints;
  never add artificial timers merely to make streaming appear animated.

## Interaction language

- Prefer research language: “project,” “question,” “working freedom,” “evidence,” “outcome,” “earlier record,” and
  “choose a folder.”
- Preserve precise Clio terms when changing them would hide scope: “target,” “model,” “session,” “turn,” and “ACP” in
  provenance or diagnostics.
- Do not use “execute” as the primary composer action. The operator sends a request; Clio decides which permitted tools
  are appropriate.
- Do not expose “fleet” or direct-agent chat unless Clio provides an explicit addressable operation. Subagents can be
  observed without pretending they are independently controllable.
- Explain timing beside configuration. Routing reaches the next turn; default autonomy reaches the next session; the
  bound session retains the autonomy Clio says it is enforcing.

## Open-source component policy

Workbench uses one design language even when implementation primitives come from several source-available libraries.
Copy only the component source needed for a concrete product surface, adapt it to Workbench tokens and semantics, and
keep the result local and testable.

Preferred sources, in order:

1. **shadcn/ui (MIT)** for durable primitives, forms, dialogs, command surfaces, sidebars, and accessibility patterns.
2. **Kibo UI (MIT)** for data-heavy views such as a bounded tree, code presentation, lists, tables, status, Kanban, or a
   Gantt-like run view when the real protocol supplies the necessary facts.
3. **Agent Elements by 21st.dev (MIT)** for selectively adopted agent/tool, plan, question, MCP, and subagent
   presentation patterns. Treat it as a younger source: inspect the code, remove runtime assumptions, and add Workbench
   tests.
4. **Blocks.so (MIT)** for onboarding, forms, command menus, file upload, statistics, and responsive shell composition.
5. **Public ReUI repository components (MIT)** when the individual source file is present under the public repository's
   license and fills a real gap.

Vercel AI Elements (Apache-2.0) may be consulted for streaming conversation patterns, but its Next.js and AI SDK
coupling must not become a second runtime inside this Vite/Deno application.

Do not copy premium ReUI Pro or Ultimate source into this repository under the standard commercial license. That license
does not permit publishing the licensed source as part of a public or open-source repository. A future custom license
would need explicit review before that changes.

Before adopting any block:

- verify the exact file and version's license;
- remove demo data and decorative metrics;
- map all colors, type, spacing, radii, and motion to Workbench tokens;
- replace developer vocabulary with domain-appropriate language without weakening precision;
- preserve keyboard, focus, screen-reader, forced-colors, reduced-motion, and compact-layout behavior;
- prove every displayed fact can be traced to a protocol field or a clearly labelled local observation;
- add unit and real-browser coverage for the state the block represents.

## How to use Stitch

Stitch is a rapid visual exploration tool, not the product authority. Ask it to explore one bounded surface or state at
a time, then port only ideas that survive the truthfulness, accessibility, protocol, and design-system checks above.

Good Stitch assignments include:

- three alternatives for an evidence card hierarchy using supplied real fields;
- a compact approval decision surface with all required facts;
- responsive arrangements for the Project atlas or Observatory;
- empty, loading, partial, failed, resumed, and truncated states for one panel;
- a graphical context or agent view from an exact supplied schema.

Avoid prompts for a generic “AI coding dashboard.” They tend to produce terminal motifs, fictional health metrics, raw
JSON, developer-only navigation, continuous neon animation, and controls that have no Clio operation behind them.

## Acceptance floor

Every UI change must preserve:

- `deno task verify`;
- the real ACP browser smoke in `deno task smoke:browser`;
- zero serious or critical Axe violations in the covered states;
- no horizontal overflow at 375 px;
- visible focus in forced colors;
- contained and restored focus for dialogs and drawers;
- meaningful loading, empty, unavailable, truncated, replayed, failed, waiting, and stopped states without relying on
  animation or color;
- no changes under `clio-coder/src/` as part of Workbench-only design work.
