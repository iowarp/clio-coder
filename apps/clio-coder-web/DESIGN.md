# Clio Coder web design

The application is a field notebook for working with code: a readable conversation alongside inspectable actions, outcomes, and evidence. The shell gives those views one place without taking ownership away from the CLI, TUI, or ACP. These rules adapt the relevant parts of `apps/workbench/DESIGN_SYSTEM.md`; its former single-project layout and unavailable-agent assumptions do not apply to this unified app.

## Truth and authority

- Display facts reported by Clio Coder, observed locally, or replayed from its ledger. Keep their provenance available. Missing usage, cost, verification, or health is not zero or success.
- A permission stays pending until explicitly answered. Escalation means it is still waiting; budget expiry means the app cancelled the turn. Cancellation and failure remain distinct outcomes.
- Target health follows a probe. Inventory and cached metadata do not imply endpoint health.
- Show problem details with their closed code and instance reference. Notifications persist until dismissed, and a small bounded stack prevents errors from filling the screen.
- Canonical workspace paths and evidence identifiers remain available where useful. Credentials and provider bodies do not become labels or summary text.

## Shell and wayfinding

The persistent desktop rail contains Overview, Sessions, Traces, Toolchain, Docs, Settings, Fleet, Evidence, Evals, Library, and System. A section is visibly unavailable until it has a working surface. The masthead carries the product identity, connection state, and theme control; the footer carries the reported Clio version.

Below 750 px the rail becomes a native modal navigation dialog. The browser owns focus containment, Escape, and return to the trigger. A skip link reaches the main landmark. Page navigation focuses that landmark and updates the document title. Main content uses flexible minimum-zero grid tracks; tables, code, and diagrams scroll within their own surfaces.

## Type, color, and scale

Fonts are local package assets. Atkinson Hyperlegible Next is the interface and reading face; Newsreader gives major headings an editorial voice; Commit Mono is reserved for exact keys, code, paths, and compact annotations. The theme tokens live in `client/design/tokens.css`; renderer rules live in `client/render/markdown.css`.

The default is warm paper with green ink and fine rules. Dark mode uses a low-chroma green/graphite frame with the same hierarchy. Action surfaces use a restrained amber treatment; errors use a red rule and text. Color always supplements an explicit label. Reading text is 15–16 px, exact annotations 12 px, and short decorative instrument labels may be 10 px. Code and diagrams use a contained dark surface in both themes.

Use shallow radii, generous space around primary work, and denser bounded details behind disclosures. The conversation has a continuous evidence rule; model prose is not a nested card. Avoid decorative counters or telemetry. Motion is limited to meaningful state changes and respects reduced-motion preferences.

## Untrusted Markdown

The GFM lexer produces tokens and React creates their text nodes and elements. Raw HTML remains visible text. Images are represented by their alt text without fetching. Only `http`, `https`, and `mailto` links are live; other destinations remain inert. Docs may later apply a trusted local-page link resolver separately from model content.

Streaming uses Workbench's incremental lexer so settled tokens retain identity while only the tail grows. Completion lexes the canonical final text. Prism loads its core and known grammars only when a settled code block is near the viewport; its output is a token tree, never highlighted HTML. Blocks over 60,000 characters remain plain. Copy is explicit, and overflowing code accepts focus for keyboard scrolling.

Mermaid loads on demand after the response settles, with strict security, SVG text labels, a 16 KiB / 400-line source ceiling, and a 400-edge renderer ceiling. Jobs run serially with a task boundary. DOMPurify sanitizes the generated SVG before DOMParser/importNode mount it; this is the renderer's only markup sink. No model HTML enters it. Diagram bounds are measured once after mount/fonts to keep translated nodes inside the viewport. Failed or oversized diagrams keep their source visible. The CSP permits inline styles for Mermaid; scripts, fonts, and connections remain same-origin.

## Verification floor

The browser smoke drives real app handlers, workers, and an ACP fixture child at 1600, 1050, and 390 px. It checks home in both themes, toolchain, traces/run detail, workspaces/sessions, a Markdown/code/Mermaid conversation, session controls, permission and cancellation, and a problem notification. It rejects serious/critical Axe findings, page overflow, unexpected error responses, script exceptions, or request failures. Hostile-Markdown tests independently verify the renderer contract. Screenshots are inspected before retaining them as slice evidence.

The code viewport has one narrowly documented Biome exception: a noninteractive `pre` must be focusable because it can scroll horizontally. Axe and an ArrowRight browser check verify the reason for that exception; no accessibility rule is disabled globally.
