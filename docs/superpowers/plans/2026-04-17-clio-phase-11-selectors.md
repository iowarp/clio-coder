# Phase 11 — TUI Selector Suite (Detailed Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between Clio v0.1.0-rc1's minimal interactive shell (5 overlays, 7 slash commands) and pi-coding-agent's selector surface by adding 7 new overlays, 7 new slash commands, 5 new keybindings, a model resolver with glob/fuzzy/`:thinking` shorthand, and a `clio --list-models [search]` headless listing. Highest user value, lowest architectural risk: every piece slots into the existing `startInteractive()` composition root without requiring new domains.

**Architecture:** Every overlay follows the established Clio pattern from `src/interactive/receipts-overlay.ts` and `providers-overlay.ts`: `openXOverlay(tui, deps, options)` returns an `OverlayHandle`; pure `formatXOverlayLines()` builders for deterministic snapshot testing; pure `routeXOverlayKey()` for input handling; Box wrapper that forwards keystrokes to focused `SelectList`/`SettingsList`. Keybindings land in `routeInteractiveKey()` and the overlay state machine. Slash commands parse through `parseSlashCommand()` and dispatch through the existing switch. Model resolver lives at `src/domains/providers/resolver.ts` (pure) and is consumed by selectors, chat-loop, CLI `--list-models`, and `clio run`.

**Tech Stack:** Existing Clio deps only. No new npm packages introduced in this phase.

---

## Context for a cold-start engineer

### Current interactive shell (`src/interactive/`)

- `index.ts` (601 LOC) — composition root: `startInteractive(deps)` wires banner + chat panel + editor + footer + 5 overlays. `OverlayState` type enumerates `"closed" | "super-confirm" | "dispatch-board" | "providers" | "cost" | "receipts"`. Pure key routers `routeInteractiveKey`, `routeSuperOverlayKey`, `routeProvidersOverlayKey`, `routeCostOverlayKey`, `routeReceiptsOverlayKey`, `routeDispatchBoardOverlayKey`. Pure slash parser `parseSlashCommand(input): SlashCommand`.
- `chat-loop.ts` (319 LOC) — orchestrator chat. `createChatLoop(deps)` reads `settings.orchestrator.{provider,model,endpoint}` each turn, resolves local-provider endpoint spec, registers it via `registerLocalProviders()`, and lazily creates `pi-agent-core` Agent.
- Overlay files: `providers-overlay.ts`, `cost-overlay.ts`, `receipts-overlay.ts`, `dispatch-board.ts`, `super-overlay.ts`. All expose `openXOverlay(tui, deps): OverlayHandle`.
- `footer-panel.ts` — `buildFooter({modes, providers, getSettings})` returns `{view, refresh}`. Reads `settings.orchestrator.provider/model` for display.
- `layout.ts` — `buildLayout({banner, chat, editor, footer})` returns Container.

### Current provider domain (`src/domains/providers/`)

- `catalog.ts` — static `PROVIDER_CATALOG: ProviderSpec[]`; each has `id`, `displayName`, `tier`, `models: ModelSpec[]`, optional `credentialsEnvVar`. `getProviderSpec(id)`, `getModelSpec(providerId, modelId)`, `isLocalEngineId()`.
- `contract.ts` — `ProvidersContract.list()` returns `ProviderListEntry[]` with live health + endpoint probes.
- Local engines (`llamacpp`, `lmstudio`, `ollama`, `openai-compat`) have zero baked-in models; user-defined endpoints in `settings.providers.{engine}.endpoints.{name}` with `EndpointSpec` carrying `default_model`, `context_window`, etc.

### Current settings (`src/core/defaults.ts`)

`DEFAULT_SETTINGS` (TypeBox-validated). Key blocks for this phase:
- `provider: { active: string | null, model: string | null }` — legacy "active" provider hints.
- `orchestrator: WorkerTargetConfig` — `{provider, endpoint, model}` for chat.
- `workers.default: WorkerTargetConfig` — for `/run` + `clio run`.
- `keybindings: Record<string, string>` — empty; no user binds yet.
- `state.lastMode` — persists mode across restarts.

**We add in this phase:**
- `provider.scope: string[]` — ordered glob/ID/pattern list for Ctrl+P cycling (pi-coding-agent: `scopedModels`).
- `orchestrator.thinkingLevel` and `workers.default.thinkingLevel` — `ThinkingLevel` enum (`off | minimal | low | medium | high | xhigh`).

### Current session domain (`src/domains/session/`)

- `SessionContract`: `current()`, `create()`, `append()`, `checkpoint()`, `resume(id)`, `fork(parentTurnId)`, `history()`, `close()`.
- `history()` already returns `ReadonlyArray<SessionMeta>` for the current cwd. Good enough for `/resume` overlay.

### Reference patterns to copy

- **SelectList overlay**: `src/interactive/receipts-overlay.ts`. Uses `ReceiptsOverlayBox` extending `Box` to forward keystrokes to the focused `SelectList`.
- **SettingsList overlay**: does not exist yet in Clio; we port `SettingsList` usage from pi-tui (already exported from `src/engine/tui.ts`). pi-coding-agent's `components/settings-selector.ts` (444 LOC) is the IP reference.
- **Live-refresh overlay**: `src/interactive/dispatch-board.ts`. `setInterval` 250ms repaint while overlay open. We do **not** use this pattern in Phase 11; all Phase 11 overlays render once.
- **Pure formatter + class wrapper pattern**: see `formatReceiptsOverlayLines(envelopes, options)` + `class ReceiptsOverlayView implements Component`. Every new overlay follows this split so `diag-selectors.ts` can drive pure `formatX...Lines()` without mounting a TUI.

### Phase 11 files produced (9 new files, 6 modified files)

**New:**
1. `src/domains/providers/resolver.ts` — pure model resolver (glob, fuzzy, `:thinking` shorthand).
2. `src/cli/list-models.ts` + `src/cli/list-models-command.ts` — `clio --list-models [search]`.
3. `src/interactive/overlays/thinking-selector.ts` — `/thinking` overlay.
4. `src/interactive/overlays/scoped-models.ts` — `/scoped-models` overlay.
5. `src/interactive/overlays/model-selector.ts` — `/model` overlay (Ctrl+L).
6. `src/interactive/overlays/settings.ts` — `/settings` overlay.
7. `src/interactive/overlays/session-selector.ts` — `/resume` overlay.
8. `src/interactive/overlays/hotkeys.ts` — `/hotkeys` overlay.
9. `scripts/diag-selectors.ts` — end-to-end verification.

**Modified:**
1. `src/interactive/index.ts` — add overlay states, slash commands, keybindings.
2. `src/core/defaults.ts` — add `provider.scope`, `orchestrator.thinkingLevel`, `workers.default.thinkingLevel`.
3. `src/domains/config/schema.ts` — mirror new fields in TypeBox schema.
4. `src/cli/index.ts` — route `--list-models` flag.
5. `src/interactive/chat-loop.ts` — honor `orchestrator.thinkingLevel` (previously hardcoded `"off"`).
6. `package.json` — add `diag:selectors` npm script.

---

## Task 1 — Provider model resolver

**Files:**
- Create: `src/domains/providers/resolver.ts`
- Modify: `src/domains/providers/index.ts` (re-export)
- Test (diag): `scripts/diag-selectors.ts` (Task 12 adds resolver checks)

### Step 1.1 — Draft the types and public API

- [ ] Create `src/domains/providers/resolver.ts` with the following interface declarations only (no implementations yet):

```ts
import type { ProviderId } from "./catalog.js";

/** Thinking levels from pi-agent-core. Mirrored here to keep the resolver pure. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export function isValidThinkingLevel(value: string): value is ThinkingLevel {
	return (VALID_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Resolved model reference carrying provider id, model id, and an optional thinking level. */
export interface ResolvedModelRef {
	providerId: ProviderId;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ResolveOptions {
	/** Optional explicit provider to scope the resolution. */
	providerId?: ProviderId;
	/** When true, pattern matches by substring (fuzzy). Default: glob (*, **, ?). */
	fuzzy?: boolean;
}

export interface ResolveResult {
	/** Matched model refs ordered by rank (exact > prefix > glob > fuzzy > substring). */
	matches: ResolvedModelRef[];
	/** Human-readable diagnostic when matches.length === 0. */
	diagnostic?: string;
}

/**
 * Parse a model pattern of one of these forms:
 *   "id"
 *   "provider/id"
 *   "id:thinking"
 *   "provider/id:thinking"
 * Returns the parsed parts. Empty string → null.
 */
export function parseModelPattern(pattern: string): {
	provider?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
} | null;

/**
 * Resolve a pattern against the provider catalog plus optional live engine endpoints.
 * Empty endpoints are OK for local engines; callers upstream validate connectivity.
 */
export function resolveModelPattern(pattern: string, options?: ResolveOptions): ResolveResult;

/**
 * Resolve a scope list (comma-separated patterns from settings.provider.scope).
 * Each pattern is resolved independently; results concatenate and deduplicate by (providerId, modelId).
 * The first occurrence wins, preserving pattern order (important for Ctrl+P cycling).
 */
export function resolveModelScope(patterns: readonly string[], options?: ResolveOptions): ResolveResult;
```

### Step 1.2 — Implement `parseModelPattern`

- [ ] Add the function body. Rules:
  - Trim input; return null if empty.
  - Split on last `/` to separate `provider/model` (if any `/`). Backslash is not valid separator (pi-coding-agent convention).
  - Split model on **last** `:` for `model:thinking` shorthand; validate against `isValidThinkingLevel`; if invalid suffix, treat the whole thing as model id (no thinking level).
  - `provider` may contain hyphens (`openai-compat`, `amazon-bedrock`); do not strip.

```ts
export function parseModelPattern(pattern: string): { provider?: string; model: string; thinkingLevel?: ThinkingLevel } | null {
	const trimmed = pattern.trim();
	if (!trimmed) return null;
	const slashIdx = trimmed.lastIndexOf("/");
	const providerPart = slashIdx === -1 ? undefined : trimmed.slice(0, slashIdx).trim();
	const remainder = slashIdx === -1 ? trimmed : trimmed.slice(slashIdx + 1).trim();
	if (!remainder) return null;
	const colonIdx = remainder.lastIndexOf(":");
	if (colonIdx !== -1) {
		const modelPart = remainder.slice(0, colonIdx).trim();
		const thinkingPart = remainder.slice(colonIdx + 1).trim();
		if (modelPart && isValidThinkingLevel(thinkingPart)) {
			return { provider: providerPart || undefined, model: modelPart, thinkingLevel: thinkingPart };
		}
	}
	return { provider: providerPart || undefined, model: remainder };
}
```

### Step 1.3 — Implement glob matcher

- [ ] Add a minimal glob → RegExp compiler next to the resolver (no new dep):

```ts
function compileGlob(pattern: string): RegExp {
	// Escape regex specials except *, ?, [, ]
	const escaped = pattern.replace(/[.+^${}()|\\]/g, "\\$&");
	const compiled = escaped
		.replace(/\*\*/g, "__CLIO_DOUBLE_STAR__")
		.replace(/\*/g, "[^/]*")
		.replace(/__CLIO_DOUBLE_STAR__/g, ".*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${compiled}$`, "i");
}

function hasGlobSyntax(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}
```

### Step 1.4 — Implement `resolveModelPattern`

- [ ] Walk `PROVIDER_CATALOG`. For each `(provider, model)`:
  - If `parsed.provider` set, skip providers whose id doesn't match (glob or exact).
  - Collect candidates. Rank in this order: exact id match; prefix match; glob match; fuzzy (case-insensitive substring) if `options.fuzzy` or no glob syntax and no prefix match.
  - Dedupe by `(providerId, modelId)`. First occurrence wins.
  - Local engines (`LOCAL_ENGINE_IDS`) have no baked models; return `{providerId, modelId: parsed.model}` verbatim if provider matches exactly or globs. This lets local endpoints be named with arbitrary model ids like `Qwen3.6-35B-A3B`.

```ts
import { LOCAL_ENGINE_IDS, PROVIDER_CATALOG, type ProviderId, isLocalEngineId } from "./catalog.js";

export function resolveModelPattern(pattern: string, options: ResolveOptions = {}): ResolveResult {
	const parsed = parseModelPattern(pattern);
	if (!parsed) {
		return { matches: [], diagnostic: `empty pattern` };
	}
	const providerFilter = parsed.provider ?? options.providerId;
	const providerMatcher = providerFilter
		? hasGlobSyntax(providerFilter)
			? compileGlob(providerFilter)
			: null
		: null;
	const candidates: Array<{ rank: number; ref: ResolvedModelRef }> = [];
	const modelGlob = hasGlobSyntax(parsed.model) ? compileGlob(parsed.model) : null;
	const fuzzy = options.fuzzy === true;

	for (const provider of PROVIDER_CATALOG) {
		if (providerFilter) {
			if (providerMatcher) {
				if (!providerMatcher.test(provider.id)) continue;
			} else if (provider.id !== providerFilter) continue;
		}
		// Local engines: no baked models, emit the requested id verbatim.
		if (provider.models.length === 0 && isLocalEngineId(provider.id)) {
			candidates.push({
				rank: 0,
				ref: {
					providerId: provider.id,
					modelId: parsed.model,
					...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
				},
			});
			continue;
		}
		for (const model of provider.models) {
			const rank = scoreModelMatch(parsed.model, model.id, { fuzzy, hasGlob: modelGlob !== null, glob: modelGlob });
			if (rank < 0) continue;
			candidates.push({
				rank,
				ref: {
					providerId: provider.id,
					modelId: model.id,
					...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
				},
			});
		}
	}

	// Dedupe preserving rank ordering.
	candidates.sort((a, b) => a.rank - b.rank);
	const seen = new Set<string>();
	const matches: ResolvedModelRef[] = [];
	for (const { ref } of candidates) {
		const key = `${ref.providerId}::${ref.modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		matches.push(ref);
	}
	if (matches.length === 0) {
		return { matches: [], diagnostic: `no model matches '${pattern}'` };
	}
	return { matches };
}

function scoreModelMatch(
	pattern: string,
	modelId: string,
	opts: { fuzzy: boolean; hasGlob: boolean; glob: RegExp | null },
): number {
	if (modelId === pattern) return 0;
	if (modelId.toLowerCase() === pattern.toLowerCase()) return 1;
	if (modelId.toLowerCase().startsWith(pattern.toLowerCase())) return 2;
	if (opts.hasGlob && opts.glob?.test(modelId)) return 3;
	if (opts.fuzzy && modelId.toLowerCase().includes(pattern.toLowerCase())) return 4;
	return -1;
}
```

### Step 1.5 — Implement `resolveModelScope`

- [ ] Iterate patterns; for each, call `resolveModelPattern`. Concatenate. Dedupe by `providerId::modelId` preserving first occurrence. Return `{matches}` or `{matches, diagnostic}` if none matched any pattern.

```ts
export function resolveModelScope(patterns: readonly string[], options: ResolveOptions = {}): ResolveResult {
	const seen = new Set<string>();
	const matches: ResolvedModelRef[] = [];
	const missing: string[] = [];
	for (const pattern of patterns) {
		const { matches: inner, diagnostic } = resolveModelPattern(pattern, options);
		if (inner.length === 0 && diagnostic) missing.push(`${pattern}: ${diagnostic}`);
		for (const ref of inner) {
			const key = `${ref.providerId}::${ref.modelId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			matches.push(ref);
		}
	}
	if (matches.length === 0) {
		return { matches: [], diagnostic: missing.join("; ") || "empty scope" };
	}
	return missing.length ? { matches, diagnostic: missing.join("; ") } : { matches };
}
```

### Step 1.6 — Export from `src/domains/providers/index.ts`

- [ ] Append to `src/domains/providers/index.ts`:

```ts
export {
	isValidThinkingLevel,
	parseModelPattern,
	resolveModelPattern,
	resolveModelScope,
	VALID_THINKING_LEVELS,
	type ResolvedModelRef,
	type ResolveOptions,
	type ResolveResult,
	type ThinkingLevel,
} from "./resolver.js";
```

### Step 1.7 — Typecheck

- [ ] Run: `npm run typecheck`
- [ ] Expected: no errors in the new resolver.

### Step 1.8 — Commit

- [ ] `git add src/domains/providers/resolver.ts src/domains/providers/index.ts`
- [ ] `git commit -m "feat(providers): add model resolver with glob/fuzzy/:thinking"`

---

## Task 2 — `clio --list-models [search]` CLI

**Files:**
- Create: `src/cli/list-models.ts`, `src/cli/list-models-command.ts`
- Modify: `src/cli/index.ts`

### Step 2.1 — Command implementation

- [ ] Create `src/cli/list-models.ts`:

```ts
import chalk from "chalk";
import { PROVIDER_CATALOG, type ProviderSpec } from "../domains/providers/catalog.js";
import { resolveModelPattern } from "../domains/providers/resolver.js";

export interface ListModelsOptions {
	/** Optional fuzzy/glob search pattern. Empty string lists everything. */
	search?: string;
	/** Test seam for deterministic output ordering. */
	stdout?: (line: string) => void;
}

export function listModels(options: ListModelsOptions = {}): number {
	const write = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
	const search = (options.search ?? "").trim();
	if (search.length === 0) {
		for (const provider of PROVIDER_CATALOG) {
			writeProviderBlock(provider, write);
		}
		return 0;
	}
	const { matches, diagnostic } = resolveModelPattern(search, { fuzzy: true });
	if (matches.length === 0) {
		process.stderr.write(`${chalk.red("no matches")}: ${diagnostic ?? search}\n`);
		return 1;
	}
	// Group by provider for readability.
	const byProvider = new Map<string, string[]>();
	for (const ref of matches) {
		const bucket = byProvider.get(ref.providerId) ?? [];
		bucket.push(ref.modelId);
		byProvider.set(ref.providerId, bucket);
	}
	for (const [providerId, models] of byProvider) {
		write(chalk.bold(providerId));
		for (const id of models) write(`  ${id}`);
	}
	return 0;
}

function writeProviderBlock(provider: ProviderSpec, write: (line: string) => void): void {
	write(chalk.bold(`${provider.id} (${provider.tier})`));
	if (provider.models.length === 0) {
		write(chalk.dim("  (no baked models; configure endpoints in settings.yaml)"));
		return;
	}
	for (const model of provider.models) {
		const ctx = `${Math.round(model.contextWindow / 1000)}k`;
		const thinking = model.thinkingCapable ? "thinking" : "";
		const price =
			model.pricePer1MInput && model.pricePer1MOutput
				? `$${model.pricePer1MInput}/${model.pricePer1MOutput} per 1M`
				: "";
		const labels = [ctx, thinking, price].filter(Boolean).join("  ");
		write(`  ${model.id.padEnd(32)} ${chalk.dim(labels)}`);
	}
}
```

### Step 2.2 — CLI command wrapper

- [ ] Create `src/cli/list-models-command.ts`:

```ts
import { listModels } from "./list-models.js";

/**
 * Parse `args` of the form:
 *   ["--list-models"]              → list all
 *   ["--list-models", "pattern"]   → filter
 * Anything else returns null so caller falls through.
 */
export function runListModelsCommand(args: readonly string[]): number | null {
	const idx = args.indexOf("--list-models");
	if (idx === -1) return null;
	const next = args[idx + 1];
	const search = next && !next.startsWith("-") ? next : undefined;
	return listModels(search !== undefined ? { search } : {});
}
```

### Step 2.3 — Wire into `src/cli/index.ts`

- [ ] Open `src/cli/index.ts`. Find the `--version`/`--help` parsing block. Just **before** the default dispatch to `runClioCommand()`, insert:

```ts
import { runListModelsCommand } from "./list-models-command.js";

// ...

const listExit = runListModelsCommand(args);
if (listExit !== null) {
	process.exit(listExit);
}
```

Exact placement: after `parseSubcommand(args)` succeeds and before the subcommand switch. If no subcommand block exists for flags (i.e. the CLI delegates unknown flags to the clio command), insert at the top of the argv-flag switch.

### Step 2.4 — Typecheck + smoke

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `node dist/cli/index.js --list-models` — expect every provider listed.
- [ ] `node dist/cli/index.js --list-models sonnet` — expect rows containing "sonnet".
- [ ] `node dist/cli/index.js --list-models nothing-matches` — expect exit code 1 and `no matches` on stderr.

### Step 2.5 — Commit

- [ ] `git add src/cli/list-models.ts src/cli/list-models-command.ts src/cli/index.ts`
- [ ] `git commit -m "feat(cli): add --list-models [search]"`

---

## Task 3 — Settings schema: `provider.scope` + thinking levels

**Files:**
- Modify: `src/core/defaults.ts`, `src/domains/config/schema.ts`, `src/core/config.ts` (if needed)

### Step 3.1 — Extend `DEFAULT_SETTINGS`

- [ ] Open `src/core/defaults.ts`. In `DEFAULT_SETTINGS` block:

Replace the existing `provider:` literal with:

```ts
	provider: {
		active: null as string | null,
		model: null as string | null,
		scope: [] as string[],
	},
```

Replace `WorkerTargetConfig` with:

```ts
export interface WorkerTargetConfig {
	provider?: string;
	endpoint?: string;
	model?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
```

(The `thinkingLevel` field is optional; existing settings files that omit it continue to work.)

### Step 3.2 — Extend `DEFAULT_SETTINGS_YAML`

- [ ] In the same file, update the commented YAML documentation so a fresh install surfaces the new fields:

```yaml
provider:
  active: null
  model: null
  # Comma-free list of model patterns to cycle through with Ctrl+P.
  # Supports globs (anthropic/*, *sonnet*) and fuzzy matching.
  # scope:
  #   - anthropic/claude-sonnet-4-6:high
  #   - openai/gpt-5
  scope: []
```

And for orchestrator / worker blocks, add a commented `thinkingLevel:` line:

```yaml
orchestrator:
  # provider: llamacpp
  # endpoint: mini
  # model: Qwen3.6-35B-A3B-UD-Q4_K_XL
  # thinkingLevel: high         # off | minimal | low | medium | high | xhigh
```

### Step 3.3 — Mirror in TypeBox schema

- [ ] Open `src/domains/config/schema.ts`. Read it first; add `scope: Type.Array(Type.String())` under `provider`, and `thinkingLevel: Type.Optional(Type.Union([...literals]))` under the worker target schema. Keep the literal order matching `VALID_THINKING_LEVELS`.

### Step 3.4 — Typecheck + verify

- [ ] `npm run typecheck`
- [ ] `npm run verify` — existing verify script round-trips `DEFAULT_SETTINGS` through `Value.Parse(SettingsSchema, parsed)`. Must still pass.

### Step 3.5 — Commit

- [ ] `git add src/core/defaults.ts src/domains/config/schema.ts`
- [ ] `git commit -m "feat(config): add provider.scope and worker thinkingLevel"`

---

## Task 4 — Thinking selector overlay

**Files:**
- Create: `src/interactive/overlays/thinking-selector.ts`
- Modify: `src/interactive/index.ts`, `src/interactive/chat-loop.ts`

### Step 4.1 — Overlay implementation

- [ ] Create `src/interactive/overlays/thinking-selector.ts`:

```ts
import type { ClioSettings } from "../../core/config.js";
import {
	VALID_THINKING_LEVELS,
	type ThinkingLevel,
} from "../../domains/providers/resolver.js";
import { Box, type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";

export const THINKING_OVERLAY_WIDTH = 44;
const IDENTITY = (s: string): string => s;
const THEME = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

const DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens",
	minimal: "short structured plan",
	low: "brief chain-of-thought",
	medium: "standard reasoning",
	high: "deep reasoning",
	xhigh: "extended thinking (models that support it)",
};

export interface OpenThinkingOverlayDeps {
	current: ThinkingLevel;
	onSelect: (next: ThinkingLevel) => void;
	onClose: () => void;
}

class ThinkingOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function buildThinkingItems(current: ThinkingLevel): SelectItem[] {
	return VALID_THINKING_LEVELS.map((lvl) => ({
		value: lvl,
		label: `${lvl === current ? "●" : " "} ${lvl}`,
		description: DESCRIPTIONS[lvl],
	}));
}

export function openThinkingOverlay(tui: TUI, deps: OpenThinkingOverlayDeps): OverlayHandle {
	const items = buildThinkingItems(deps.current);
	const initialIndex = Math.max(0, VALID_THINKING_LEVELS.indexOf(deps.current));
	const list = new SelectList({
		items,
		theme: THEME,
		initialIndex,
		onSelect: (item) => {
			deps.onSelect(item.value as ThinkingLevel);
			deps.onClose();
		},
		onCancel: () => deps.onClose(),
	});
	const box = new ThinkingOverlayBox(list);
	box.addChild(list);
	const handle = tui.showOverlay(box, { anchor: "center", width: THINKING_OVERLAY_WIDTH });
	tui.setFocus(list);
	return handle;
}

/** Pure resolver used by chat-loop + settings writer. */
export function readThinkingLevel(settings: Readonly<ClioSettings>): ThinkingLevel {
	const lvl = settings.orchestrator.thinkingLevel;
	return lvl ?? "off";
}
```

### Step 4.2 — Add overlay state + slash + keybinding

- [ ] Open `src/interactive/index.ts`. Extend the types:

Replace the `OverlayState` type with:

```ts
export type OverlayState =
	| "closed"
	| "super-confirm"
	| "dispatch-board"
	| "providers"
	| "cost"
	| "receipts"
	| "thinking"
	| "scoped-models"
	| "model-selector"
	| "settings"
	| "session-selector"
	| "hotkeys";
```

Add to the `SlashCommand` union:

```ts
	| { kind: "thinking" }
```

In `parseSlashCommand`, add `if (trimmed === "/thinking") return { kind: "thinking" };` before the unknown fallthrough.

In `startInteractive()`, add:

```ts
import { openThinkingOverlay, readThinkingLevel } from "./overlays/thinking-selector.js";
```

Add a handler near the other `openXOverlayState()` helpers:

```ts
	const openThinkingOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "thinking";
		const settings = deps.getSettings?.();
		const current = settings ? readThinkingLevel(settings) : "off";
		overlayHandle = openThinkingOverlay(tui, {
			current,
			onSelect: (next) => {
				deps.onSetThinkingLevel?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};
```

Dispatch in the slash switch:

```ts
case "thinking":
	openThinkingOverlayState();
	return;
```

Add to `InteractiveDeps`:

```ts
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
```

(Import `ThinkingLevel` from `../domains/providers/resolver.js`.)

### Step 4.3 — Route Shift+Tab to thinking

- [ ] Per the port plan §4 Phase 11, `Shift+Tab` is **reassigned** from mode-cycle to thinking-cycle; `Alt+M` takes over mode-cycle. Update `routeInteractiveKey`:

```ts
export function routeInteractiveKey(data: string, deps: KeyBindingDeps): boolean {
	if (data === ALT_S) {
		deps.requestSuper();
		return true;
	}
	if (data === SHIFT_TAB) {
		deps.cycleThinking();
		return true;
	}
	if (data === ALT_M) {
		deps.cycleMode();
		return true;
	}
	if (data === CTRL_B) {
		deps.toggleDispatchBoard();
		return true;
	}
	if (data === CTRL_D) {
		deps.requestShutdown();
		return true;
	}
	return false;
}
```

Add the constants near the existing keybinding constants:

```ts
export const ALT_M = "\x1bm";
```

Extend `KeyBindingDeps`:

```ts
export interface KeyBindingDeps {
	cycleMode: () => void;
	cycleThinking: () => void;
	requestShutdown: () => void;
	requestSuper: () => void;
	toggleDispatchBoard: () => void;
}
```

In the input listener inside `startInteractive`, wire `cycleThinking: () => { deps.onCycleThinking?.(); footer.refresh(); tui.requestRender(); }` and add `onCycleThinking?: () => void` to `InteractiveDeps`.

### Step 4.4 — Chat-loop consumes thinking level

- [ ] Open `src/interactive/chat-loop.ts`. Replace the hardcoded `thinkingLevel: "off"` in `ensureRuntime()` with:

```ts
			thinkingLevel: (deps.getSettings().orchestrator.thinkingLevel ?? "off"),
```

If `deps.getSettings` is not present on `CreateChatLoopDeps`, add it (it is present already — confirm).

### Step 4.5 — Composition root supplies callbacks

- [ ] Open `src/entry/orchestrator.ts`. Find the `startInteractive({...})` call. Add the three new callbacks next to the existing ones:

```ts
		onSetThinkingLevel: (level) => {
			// Mutate settings.orchestrator.thinkingLevel and persist atomically.
			const current = readSettings();
			current.orchestrator.thinkingLevel = level;
			writeSettings(current);
		},
		onCycleThinking: () => {
			const current = readSettings();
			const idx = VALID_THINKING_LEVELS.indexOf(current.orchestrator.thinkingLevel ?? "off");
			const next = VALID_THINKING_LEVELS[(idx + 1) % VALID_THINKING_LEVELS.length];
			current.orchestrator.thinkingLevel = next;
			writeSettings(current);
		},
```

(Imports: `VALID_THINKING_LEVELS` from `src/domains/providers/resolver.js`; `readSettings`/`writeSettings` from existing config helpers.)

### Step 4.6 — Typecheck + manual TUI drill

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `CLIO_HOME=$(mktemp -d) node dist/cli/index.js` (needs TTY — see diag script later for non-interactive check).
- [ ] Press `Shift+Tab` → footer thinking level cycles.
- [ ] Type `/thinking` → overlay opens; Up/Down selects; Enter commits; Esc cancels.

### Step 4.7 — Commit

- [ ] `git add src/interactive/overlays/thinking-selector.ts src/interactive/index.ts src/interactive/chat-loop.ts src/entry/orchestrator.ts`
- [ ] `git commit -m "feat(interactive): add /thinking overlay + Shift+Tab cycle"`

---

## Task 5 — Scoped-models overlay (`/scoped-models`)

**Files:**
- Create: `src/interactive/overlays/scoped-models.ts`
- Modify: `src/interactive/index.ts`, `src/entry/orchestrator.ts`

### Step 5.1 — Overlay implementation

Use a `SelectList` with multi-selection semantics. pi-tui's `SelectList` exposes `selected: Set<string>` and a `multi: true` option. Verify via `src/engine/tui.ts` re-export that `multi` is supported; if not, simulate multi-select by binding Space to toggle an item and Enter to commit.

- [ ] Create `src/interactive/overlays/scoped-models.ts`:

```ts
import type { ClioSettings } from "../../core/config.js";
import { PROVIDER_CATALOG } from "../../domains/providers/catalog.js";
import { resolveModelScope } from "../../domains/providers/resolver.js";
import { Box, type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";

export const SCOPED_WIDTH = 72;
const IDENTITY = (s: string): string => s;
const THEME = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

/**
 * Build select items from the static catalog. Local-engine rows only appear if
 * the user has explicitly added them via a pattern; they are filtered out of
 * the initial picker to avoid noise.
 */
export function buildScopedModelItems(currentScope: ReadonlyArray<string>): SelectItem[] {
	const activeResolved = new Set(
		resolveModelScope(currentScope).matches.map((ref) => `${ref.providerId}::${ref.modelId}`),
	);
	const items: SelectItem[] = [];
	for (const provider of PROVIDER_CATALOG) {
		for (const model of provider.models) {
			const key = `${provider.id}::${model.id}`;
			const selected = activeResolved.has(key);
			items.push({
				value: `${provider.id}/${model.id}`,
				label: `${selected ? "[x]" : "[ ]"} ${provider.id}/${model.id}`,
				description: model.thinkingCapable ? "thinking" : "",
			});
		}
	}
	return items;
}

export interface OpenScopedOverlayDeps {
	currentScope: ReadonlyArray<string>;
	onCommit: (nextScope: string[]) => void;
	onClose: () => void;
}

class ScopedOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openScopedOverlay(tui: TUI, deps: OpenScopedOverlayDeps): OverlayHandle {
	const selectedSet = new Set<string>();
	const initial = new Set(
		resolveModelScope(deps.currentScope).matches.map((ref) => `${ref.providerId}/${ref.modelId}`),
	);
	for (const v of initial) selectedSet.add(v);

	const items = buildScopedModelItems(deps.currentScope);
	const rebuildLabels = (): void => {
		for (const item of items) {
			const sel = selectedSet.has(item.value);
			item.label = `${sel ? "[x]" : "[ ]"} ${item.value}`;
		}
	};

	const list = new SelectList({
		items,
		theme: THEME,
		onSelect: () => {}, // Space toggles; Enter commits (below).
		onCancel: () => deps.onClose(),
	});
	const box = new ScopedOverlayBox(list);
	box.addChild(list);
	const handle = tui.showOverlay(box, { anchor: "center", width: SCOPED_WIDTH });
	tui.setFocus(list);

	const orig = list.handleInput.bind(list);
	list.handleInput = (data: string) => {
		if (data === " ") {
			const item = list.items[list.selectedIndex];
			if (!item) return;
			if (selectedSet.has(item.value)) selectedSet.delete(item.value);
			else selectedSet.add(item.value);
			rebuildLabels();
			list.invalidate();
			return;
		}
		if (data === "\r") {
			// Preserve order per PROVIDER_CATALOG (build order).
			const next = items.filter((i) => selectedSet.has(i.value)).map((i) => i.value);
			deps.onCommit(next);
			deps.onClose();
			return;
		}
		orig(data);
	};

	return handle;
}

export function extractScopeFromSettings(settings: Readonly<ClioSettings>): string[] {
	return [...(settings.provider.scope ?? [])];
}
```

### Step 5.2 — Wire into interactive

- [ ] Add `scoped-models` to `OverlayState` (done in Task 4). Add slash kind and handler similar to `/thinking`:

In `parseSlashCommand`, add:

```ts
if (trimmed === "/scoped-models") return { kind: "scoped-models" };
```

Add `{ kind: "scoped-models" }` to the `SlashCommand` union.

In `startInteractive`, add:

```ts
import { extractScopeFromSettings, openScopedOverlay } from "./overlays/scoped-models.js";
```

Add `openScopedOverlayState()` and dispatch in the slash switch. Persist via `deps.onSetScope?.(next)` (new optional callback in `InteractiveDeps`).

### Step 5.3 — Composition root persistence

- [ ] In `src/entry/orchestrator.ts`, add:

```ts
		onSetScope: (scope) => {
			const current = readSettings();
			current.provider.scope = scope;
			writeSettings(current);
		},
```

### Step 5.4 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/overlays/scoped-models.ts src/interactive/index.ts src/entry/orchestrator.ts`
- [ ] `git commit -m "feat(interactive): add /scoped-models overlay"`

---

## Task 6 — Model selector overlay (`/model` / Ctrl+L)

**Files:**
- Create: `src/interactive/overlays/model-selector.ts`
- Modify: `src/interactive/index.ts`, `src/entry/orchestrator.ts`

### Step 6.1 — Overlay implementation

- [ ] Create `src/interactive/overlays/model-selector.ts`:

```ts
import type { ClioSettings } from "../../core/config.js";
import type { ProviderListEntry, ProvidersContract } from "../../domains/providers/contract.js";
import { resolveModelScope } from "../../domains/providers/resolver.js";
import { Box, type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";
import { PROVIDER_CATALOG } from "../../domains/providers/catalog.js";

export const MODEL_OVERLAY_WIDTH = 78;
const IDENTITY = (s: string): string => s;
const THEME = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

export interface ModelOverlayDeps {
	settings: Readonly<ClioSettings>;
	providers: ProvidersContract;
	onSelect: (ref: { providerId: string; modelId: string; endpoint?: string }) => void;
	onClose: () => void;
}

function formatHealth(entry: ProviderListEntry | undefined): string {
	if (!entry) return "?";
	switch (entry.health.status) {
		case "healthy": return "●";
		case "degraded": return "◐";
		case "down": return "○";
		default: return "·";
	}
}

export function buildModelItems(deps: { settings: Readonly<ClioSettings>; providers: ProvidersContract }): SelectItem[] {
	const list = deps.providers.list();
	const byId = new Map(list.map((e) => [e.id, e]));
	const scopeSet = new Set(
		resolveModelScope(deps.settings.provider.scope ?? []).matches.map((r) => `${r.providerId}::${r.modelId}`),
	);
	const items: SelectItem[] = [];
	for (const provider of PROVIDER_CATALOG) {
		const listEntry = byId.get(provider.id);
		const health = formatHealth(listEntry);
		if (provider.models.length === 0) {
			const endpoints = listEntry?.endpoints ?? [];
			for (const ep of endpoints) {
				items.push({
					value: `${provider.id}/${ep.name}/${ep.defaultModel ?? ""}`,
					label: `${health} ${provider.id}/${ep.name}  ${ep.defaultModel ?? "(model unset)"}`,
					description: ep.probe?.ok ? `endpoint ok ${ep.url}` : `endpoint ${ep.probe?.error ?? "unprobed"}`,
				});
			}
			continue;
		}
		for (const model of provider.models) {
			const key = `${provider.id}::${model.id}`;
			const scoped = scopeSet.has(key) ? "★" : " ";
			const price =
				model.pricePer1MInput && model.pricePer1MOutput
					? ` $${model.pricePer1MInput}/${model.pricePer1MOutput}`
					: "";
			items.push({
				value: `${provider.id}/${model.id}`,
				label: `${health}${scoped} ${provider.id}/${model.id}`,
				description: `${Math.round(model.contextWindow / 1000)}k${price}`,
			});
		}
	}
	return items;
}

class ModelOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openModelOverlay(tui: TUI, deps: ModelOverlayDeps): OverlayHandle {
	const items = buildModelItems({ settings: deps.settings, providers: deps.providers });
	const list = new SelectList({
		items,
		theme: THEME,
		onSelect: (item) => {
			const parts = item.value.split("/");
			const providerId = parts[0];
			if (parts.length === 3) {
				deps.onSelect({ providerId, endpoint: parts[1], modelId: parts[2] });
			} else {
				deps.onSelect({ providerId, modelId: parts.slice(1).join("/") });
			}
			deps.onClose();
		},
		onCancel: () => deps.onClose(),
	});
	const box = new ModelOverlayBox(list);
	box.addChild(list);
	const handle = tui.showOverlay(box, { anchor: "center", width: MODEL_OVERLAY_WIDTH });
	tui.setFocus(list);
	return handle;
}
```

### Step 6.2 — Slash + keybinding wiring

- [ ] In `src/interactive/index.ts`:
  - Add `{ kind: "model" }` to `SlashCommand`. Parser: `if (trimmed === "/model") return { kind: "model" };`.
  - Add `CTRL_L = "\x0c"` constant.
  - Extend `KeyBindingDeps.openModelSelector: () => void`; route `CTRL_L` to it.
  - Add `openModelOverlayState()` and dispatch.
  - Add `onSelectModel?: (ref: {providerId: string; modelId: string; endpoint?: string}) => void` to `InteractiveDeps`.

### Step 6.3 — Composition root persistence

- [ ] In `src/entry/orchestrator.ts` under the `startInteractive` call:

```ts
		onSelectModel: ({ providerId, modelId, endpoint }) => {
			const current = readSettings();
			current.orchestrator.provider = providerId;
			current.orchestrator.model = modelId;
			if (endpoint) current.orchestrator.endpoint = endpoint;
			else delete current.orchestrator.endpoint;
			writeSettings(current);
		},
```

### Step 6.4 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/overlays/model-selector.ts src/interactive/index.ts src/entry/orchestrator.ts`
- [ ] `git commit -m "feat(interactive): add /model overlay and Ctrl+L"`

---

## Task 7 — Settings overlay (`/settings`)

**Files:**
- Create: `src/interactive/overlays/settings.ts`
- Modify: `src/interactive/index.ts`, `src/entry/orchestrator.ts`

### Step 7.1 — Overlay implementation

pi-tui exports `SettingsList` with items of type `SettingItem` (re-exported via `src/engine/tui.ts`). `SettingsList` is a categorized list with inline editable values.

- [ ] Create `src/interactive/overlays/settings.ts`:

```ts
import type { ClioSettings } from "../../core/config.js";
import {
	Box,
	type OverlayHandle,
	type SettingItem,
	SettingsList,
	type TUI,
} from "../../engine/tui.js";

export const SETTINGS_OVERLAY_WIDTH = 80;
const IDENTITY = (s: string): string => s;
const THEME = {
	categoryLabel: IDENTITY,
	keyLabel: IDENTITY,
	value: IDENTITY,
	description: IDENTITY,
	selectedKey: IDENTITY,
	selectedValue: IDENTITY,
	scrollInfo: IDENTITY,
};

export interface SettingsOverlayDeps {
	getSettings: () => Readonly<ClioSettings>;
	writeSettings: (next: ClioSettings) => void;
	onClose: () => void;
}

export function buildSettingItems(settings: Readonly<ClioSettings>): SettingItem[] {
	const items: SettingItem[] = [];
	items.push(
		{ category: "General", key: "defaultMode", value: settings.defaultMode, description: "default | advise | super" },
		{ category: "General", key: "safetyLevel", value: settings.safetyLevel, description: "suggest | auto-edit | full-auto" },
		{ category: "General", key: "theme", value: settings.theme, description: "default (Phase 13 adds alternatives)" },
		{ category: "Budget", key: "budget.sessionCeilingUsd", value: String(settings.budget.sessionCeilingUsd), description: "USD cap per session" },
		{ category: "Budget", key: "budget.concurrency", value: String(settings.budget.concurrency), description: "'auto' or positive integer" },
		{
			category: "Orchestrator",
			key: "orchestrator.provider",
			value: settings.orchestrator.provider ?? "(unset)",
			description: "Active provider for chat",
		},
		{
			category: "Orchestrator",
			key: "orchestrator.model",
			value: settings.orchestrator.model ?? "(unset)",
			description: "Active model id",
		},
		{
			category: "Orchestrator",
			key: "orchestrator.thinkingLevel",
			value: settings.orchestrator.thinkingLevel ?? "off",
			description: "off | minimal | low | medium | high | xhigh",
		},
		{
			category: "Workers",
			key: "workers.default.provider",
			value: settings.workers.default.provider ?? "(unset)",
			description: "/run provider",
		},
		{
			category: "Workers",
			key: "workers.default.model",
			value: settings.workers.default.model ?? "(unset)",
			description: "/run model id",
		},
		{
			category: "Scope",
			key: "provider.scope",
			value: (settings.provider.scope ?? []).join(", ") || "(empty)",
			description: "Ctrl+P cycle; edit in /scoped-models",
		},
	);
	return items;
}

class SettingsOverlayBox extends Box {
	constructor(private readonly list: SettingsList) {
		super(1, 0);
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openSettingsOverlay(tui: TUI, deps: SettingsOverlayDeps): OverlayHandle {
	const items = buildSettingItems(deps.getSettings());
	const list = new SettingsList({
		items,
		theme: THEME,
		onCommit: (key, value) => {
			const current = deps.getSettings();
			applySettingChange(current, key, value);
			deps.writeSettings(current);
		},
		onCancel: () => deps.onClose(),
	});
	const box = new SettingsOverlayBox(list);
	box.addChild(list);
	const handle = tui.showOverlay(box, { anchor: "center", width: SETTINGS_OVERLAY_WIDTH });
	tui.setFocus(list);
	return handle;
}

/** Pure mutation applied in-place. Exposed for diag-selectors. */
export function applySettingChange(settings: ClioSettings, key: string, value: string): void {
	switch (key) {
		case "defaultMode":
			if (value === "default" || value === "advise" || value === "super") settings.defaultMode = value;
			return;
		case "safetyLevel":
			if (value === "suggest" || value === "auto-edit" || value === "full-auto") settings.safetyLevel = value;
			return;
		case "theme":
			settings.theme = value;
			return;
		case "budget.sessionCeilingUsd": {
			const n = Number(value);
			if (Number.isFinite(n) && n >= 0) settings.budget.sessionCeilingUsd = n;
			return;
		}
		case "budget.concurrency": {
			if (value === "auto") {
				settings.budget.concurrency = "auto";
				return;
			}
			const n = Number(value);
			if (Number.isInteger(n) && n > 0) settings.budget.concurrency = n;
			return;
		}
		case "orchestrator.provider":
			settings.orchestrator.provider = value || undefined;
			return;
		case "orchestrator.model":
			settings.orchestrator.model = value || undefined;
			return;
		case "orchestrator.thinkingLevel":
			if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
				settings.orchestrator.thinkingLevel = value as ClioSettings["orchestrator"]["thinkingLevel"];
			}
			return;
		case "workers.default.provider":
			settings.workers.default.provider = value || undefined;
			return;
		case "workers.default.model":
			settings.workers.default.model = value || undefined;
			return;
	}
}
```

### Step 7.2 — Wire `/settings`

- [ ] In `src/interactive/index.ts`: add to union + parser + handler. In `src/entry/orchestrator.ts`: supply `getSettings` and `writeSettings` wrappers.

### Step 7.3 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/overlays/settings.ts src/interactive/index.ts src/entry/orchestrator.ts`
- [ ] `git commit -m "feat(interactive): add /settings overlay"`

---

## Task 8 — Session selector overlay (`/resume`)

**Files:**
- Create: `src/interactive/overlays/session-selector.ts`
- Modify: `src/interactive/index.ts`, `src/entry/orchestrator.ts`

### Step 8.1 — Overlay implementation

- [ ] Create `src/interactive/overlays/session-selector.ts`:

```ts
import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import { Box, type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";

export const SESSION_OVERLAY_WIDTH = 80;
const IDENTITY = (s: string): string => s;
const THEME = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

export interface SessionOverlayDeps {
	session: SessionContract;
	onResume: (sessionId: string) => void;
	onClose: () => void;
}

function shortenId(id: string): string {
	return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export function buildSessionItems(sessions: ReadonlyArray<SessionMeta>): SelectItem[] {
	return sessions.map((meta) => {
		const started = meta.createdAt ? new Date(meta.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
		const ended = meta.endedAt ? "✓" : "●";
		const model = meta.model ?? "-";
		const provider = meta.provider ?? "-";
		return {
			value: meta.id,
			label: `${ended} ${shortenId(meta.id)}  ${started}  ${provider}/${model}`,
			description: meta.cwd ?? "",
		};
	});
}

class SessionOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openSessionOverlay(tui: TUI, deps: SessionOverlayDeps): OverlayHandle {
	const sessions = deps.session.history();
	const items = buildSessionItems(sessions);
	const list = new SelectList({
		items,
		theme: THEME,
		onSelect: (item) => {
			deps.onResume(item.value);
			deps.onClose();
		},
		onCancel: () => deps.onClose(),
	});
	const box = new SessionOverlayBox(list);
	box.addChild(list);
	const handle = tui.showOverlay(box, { anchor: "center", width: SESSION_OVERLAY_WIDTH });
	tui.setFocus(list);
	return handle;
}
```

### Step 8.2 — Wire `/resume` and `/new`

- [ ] In `src/interactive/index.ts`: add `{kind: "resume"}` and `{kind: "new"}` to the `SlashCommand` union. Parser handles `/resume` and `/new`. `/resume` opens `openSessionOverlay`; `/new` calls `deps.onNewSession?.()` which forwards to `session.create({cwd: process.cwd()})` + closes + resets chat panel.

### Step 8.3 — Orchestrator hooks

- [ ] In `src/entry/orchestrator.ts`:

```ts
		onResumeSession: (sessionId) => {
			session.resume(sessionId);
		},
		onNewSession: () => {
			session.create({ cwd: process.cwd() });
		},
```

Note that `session` is the already-created `SessionContract` instance; `resume` returns metadata but the orchestrator just needs to re-bind its internal `lastTurnId` counter. For Phase 11, returning to the welcome banner is sufficient; fork-from-message lands in Phase 12. Document the limitation in the chat panel with a brief notice.

### Step 8.4 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/overlays/session-selector.ts src/interactive/index.ts src/entry/orchestrator.ts`
- [ ] `git commit -m "feat(interactive): add /resume and /new session overlays"`

---

## Task 9 — Hotkeys overlay (`/hotkeys`)

**Files:**
- Create: `src/interactive/overlays/hotkeys.ts`
- Modify: `src/interactive/index.ts`

### Step 9.1 — Overlay implementation

- [ ] Create `src/interactive/overlays/hotkeys.ts`:

```ts
import { Box, type Component, type OverlayHandle, type TUI, truncateToWidth } from "../../engine/tui.js";

export const HOTKEYS_OVERLAY_WIDTH = 68;

export interface HotkeyEntry {
	keys: string;
	action: string;
	scope: "global" | "overlay" | "editor";
}

export const HOTKEYS: ReadonlyArray<HotkeyEntry> = [
	{ keys: "Shift+Tab", action: "Cycle thinking level", scope: "global" },
	{ keys: "Alt+M", action: "Cycle mode (default ⇄ advise)", scope: "global" },
	{ keys: "Alt+S", action: "Enter super mode (confirmation)", scope: "global" },
	{ keys: "Ctrl+L", action: "Open model selector", scope: "global" },
	{ keys: "Ctrl+P / Shift+Ctrl+P", action: "Cycle scoped models forward/back (Phase 11: hook TBA)", scope: "global" },
	{ keys: "Ctrl+B", action: "Toggle dispatch board", scope: "global" },
	{ keys: "Ctrl+D", action: "Exit", scope: "global" },
	{ keys: "Esc", action: "Cancel stream / close overlay", scope: "global" },
	{ keys: "/help", action: "List commands", scope: "editor" },
	{ keys: "/thinking", action: "Open thinking selector", scope: "editor" },
	{ keys: "/scoped-models", action: "Edit Ctrl+P cycle set", scope: "editor" },
	{ keys: "/model", action: "Open model selector", scope: "editor" },
	{ keys: "/settings", action: "Open settings", scope: "editor" },
	{ keys: "/resume", action: "Open session picker", scope: "editor" },
	{ keys: "/new", action: "Start a new session", scope: "editor" },
	{ keys: "/providers", action: "Open providers overlay", scope: "editor" },
	{ keys: "/cost", action: "Open cost overlay", scope: "editor" },
	{ keys: "/receipts", action: "Open receipts overlay", scope: "editor" },
	{ keys: "/run <agent> <task>", action: "Dispatch agent", scope: "editor" },
];

function pad(text: string, width: number): string {
	if (text.length >= width) return truncateToWidth(text, width, "", true);
	return text.padEnd(width);
}

export function formatHotkeysLines(contentWidth: number = HOTKEYS_OVERLAY_WIDTH - 4): string[] {
	const keysCol = 26;
	const actionCol = Math.max(10, contentWidth - keysCol - 8);
	const lines = [
		`┌${" Hotkeys ".padEnd(contentWidth + 2, "─")}┐`,
	];
	let lastScope: string | null = null;
	for (const hk of HOTKEYS) {
		if (hk.scope !== lastScope) {
			lastScope = hk.scope;
			lines.push(`│ ${pad(`── ${hk.scope.toUpperCase()}`, contentWidth)} │`);
		}
		const row = `${pad(hk.keys, keysCol)}  ${pad(hk.action, actionCol)}`;
		lines.push(`│ ${pad(row, contentWidth)} │`);
	}
	lines.push(`│ ${pad("[Esc] close", contentWidth)} │`);
	lines.push(`└${"─".repeat(contentWidth + 2)}┘`);
	return lines;
}

class HotkeysView implements Component {
	render(width: number): string[] {
		return formatHotkeysLines(Math.max(10, width - 4));
	}
	invalidate(): void {}
}

export function openHotkeysOverlay(tui: TUI, onClose: () => void): OverlayHandle {
	const box = new Box(0, 0);
	box.addChild(new HotkeysView());
	const handle = tui.showOverlay(box, { anchor: "center", width: HOTKEYS_OVERLAY_WIDTH });
	return {
		...handle,
		hide() {
			handle.hide();
			onClose();
		},
	};
}
```

### Step 9.2 — Wire `/hotkeys`

- [ ] In `src/interactive/index.ts`: add to union + parser + dispatch. Esc closes. Add the overlay state `hotkeys` (already in the union from Task 4).

### Step 9.3 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/overlays/hotkeys.ts src/interactive/index.ts`
- [ ] `git commit -m "feat(interactive): add /hotkeys overlay"`

---

## Task 10 — Ctrl+P scoped-model cycling

**Files:**
- Modify: `src/interactive/index.ts`, `src/entry/orchestrator.ts`

### Step 10.1 — Keybindings

- [ ] Add `CTRL_P = "\x10"`, `SHIFT_CTRL_P = "\x1b[P;2u"` (CSI-u sequence; match pi-coding-agent shift+ctrl+p default; fall back to `matchesKey(data, "shift+ctrl+p")`).
- [ ] Extend `KeyBindingDeps.cycleScopedModelForward: () => void` and `cycleScopedModelBackward: () => void`.
- [ ] Route both in `routeInteractiveKey`.

### Step 10.2 — Composition root cycling

- [ ] In `src/entry/orchestrator.ts`:

```ts
		onCycleScopedModelForward: () => cycleScoped("forward"),
		onCycleScopedModelBackward: () => cycleScoped("backward"),
```

```ts
	function cycleScoped(dir: "forward" | "backward"): void {
		const current = readSettings();
		const patterns = current.provider.scope ?? [];
		if (patterns.length === 0) return;
		const resolved = resolveModelScope(patterns).matches;
		if (resolved.length === 0) return;
		const active = `${current.orchestrator.provider ?? ""}::${current.orchestrator.model ?? ""}`;
		const idx = resolved.findIndex((r) => `${r.providerId}::${r.modelId}` === active);
		const step = dir === "forward" ? 1 : resolved.length - 1;
		const next = resolved[(idx === -1 ? 0 : idx + step) % resolved.length];
		current.orchestrator.provider = next.providerId;
		current.orchestrator.model = next.modelId;
		if (next.thinkingLevel) current.orchestrator.thinkingLevel = next.thinkingLevel;
		writeSettings(current);
	}
```

### Step 10.3 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/index.ts src/entry/orchestrator.ts`
- [ ] `git commit -m "feat(interactive): Ctrl+P cycles scoped models"`

---

## Task 11 — Footer shows thinking level + model cycle index

**Files:**
- Modify: `src/interactive/footer-panel.ts`

### Step 11.1 — Expand footer content

- [ ] Open `src/interactive/footer-panel.ts`. Extend the status string to:

```
[mode] [provider/model:thinking] [scoped:N/M] [cost $x.xx]
```

Where `scoped: N/M` reads `provider.scope` resolved set and shows the index of the current orchestrator within it (`?` if not in scope, `N/M` otherwise). `thinking` reads `orchestrator.thinkingLevel` (omit when "off").

### Step 11.2 — Typecheck + commit

- [ ] `npm run typecheck`
- [ ] `git add src/interactive/footer-panel.ts`
- [ ] `git commit -m "feat(interactive): footer shows thinking + scope index"`

---

## Task 12 — `diag-selectors.ts` script

**Files:**
- Create: `scripts/diag-selectors.ts`
- Modify: `package.json` (add `diag:selectors` script)

### Step 12.1 — Script skeleton

- [ ] Create `scripts/diag-selectors.ts`:

```ts
/**
 * Diag: exercise every Phase 11 selector component via pure functions and
 * in-process assertions. No TUI mount required. Exits 0 on success.
 *
 * Cover:
 *  - parseModelPattern + resolveModelPattern + resolveModelScope
 *  - listModels() text capture
 *  - buildThinkingItems / buildScopedModelItems / buildModelItems /
 *    buildSettingItems / buildSessionItems / formatHotkeysLines
 *  - applySettingChange round-trip on a synthetic settings object
 *  - routeInteractiveKey for Shift+Tab / Alt+M / Ctrl+L / Ctrl+B / Ctrl+D
 *  - parseSlashCommand for every Phase 11 command
 */

import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/core/defaults.js";
import type { ClioSettings } from "../src/core/config.js";
import { listModels } from "../src/cli/list-models.js";
import {
	parseModelPattern,
	resolveModelPattern,
	resolveModelScope,
	VALID_THINKING_LEVELS,
} from "../src/domains/providers/resolver.js";
import {
	ALT_M,
	CTRL_B,
	CTRL_D,
	CTRL_L,
	parseSlashCommand,
	routeInteractiveKey,
	SHIFT_TAB,
} from "../src/interactive/index.js";
import { buildThinkingItems } from "../src/interactive/overlays/thinking-selector.js";
import { buildScopedModelItems } from "../src/interactive/overlays/scoped-models.js";
import { buildModelItems } from "../src/interactive/overlays/model-selector.js";
import { applySettingChange, buildSettingItems } from "../src/interactive/overlays/settings.js";
import { buildSessionItems } from "../src/interactive/overlays/session-selector.js";
import { formatHotkeysLines, HOTKEYS } from "../src/interactive/overlays/hotkeys.js";

const captured: string[] = [];
const write = (line: string): void => {
	captured.push(line);
};

function logPass(name: string): void {
	process.stdout.write(`[diag-selectors] ok  ${name}\n`);
}

function logFail(name: string, err: unknown): never {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[diag-selectors] FAIL ${name}: ${msg}\n`);
	process.exit(1);
}

function run(name: string, fn: () => void | Promise<void>): void {
	try {
		const p = fn();
		if (p instanceof Promise) {
			p.then(() => logPass(name)).catch((err) => logFail(name, err));
		} else {
			logPass(name);
		}
	} catch (err) {
		logFail(name, err);
	}
}

// 1. parseModelPattern
run("parseModelPattern: plain id", () => {
	assert.deepEqual(parseModelPattern("gpt-5"), { model: "gpt-5" });
});
run("parseModelPattern: provider/id", () => {
	assert.deepEqual(parseModelPattern("openai/gpt-5"), { provider: "openai", model: "gpt-5" });
});
run("parseModelPattern: id:thinking", () => {
	assert.deepEqual(parseModelPattern("gpt-5:high"), { model: "gpt-5", thinkingLevel: "high" });
});
run("parseModelPattern: provider/id:thinking", () => {
	assert.deepEqual(parseModelPattern("openai/gpt-5:xhigh"), {
		provider: "openai",
		model: "gpt-5",
		thinkingLevel: "xhigh",
	});
});
run("parseModelPattern: empty", () => {
	assert.equal(parseModelPattern(""), null);
});

// 2. resolveModelPattern
run("resolveModelPattern: exact", () => {
	const r = resolveModelPattern("openai/gpt-5");
	assert.equal(r.matches.length, 1);
	assert.equal(r.matches[0].providerId, "openai");
});
run("resolveModelPattern: glob", () => {
	const r = resolveModelPattern("anthropic/*sonnet*");
	assert.ok(r.matches.length >= 1);
	assert.ok(r.matches.every((m) => m.providerId === "anthropic"));
});
run("resolveModelPattern: fuzzy", () => {
	const r = resolveModelPattern("sonnet", { fuzzy: true });
	assert.ok(r.matches.some((m) => m.modelId.includes("sonnet")));
});
run("resolveModelPattern: no-match", () => {
	const r = resolveModelPattern("xyzzy");
	assert.equal(r.matches.length, 0);
	assert.ok(r.diagnostic);
});

// 3. resolveModelScope
run("resolveModelScope: dedupe preserves first-match order", () => {
	const r = resolveModelScope(["openai/gpt-5", "openai/gpt-5", "anthropic/claude-sonnet-4-6"]);
	assert.equal(r.matches.length, 2);
	assert.equal(r.matches[0].modelId, "gpt-5");
});

// 4. listModels
run("listModels: empty search dumps catalog", () => {
	captured.length = 0;
	const code = listModels({ stdout: write });
	assert.equal(code, 0);
	assert.ok(captured.length > 0);
	assert.ok(captured.some((l) => l.includes("anthropic")));
});
run("listModels: fuzzy search", () => {
	captured.length = 0;
	const code = listModels({ search: "sonnet", stdout: write });
	assert.equal(code, 0);
	assert.ok(captured.some((l) => l.includes("sonnet")));
});
run("listModels: no-match returns 1", () => {
	captured.length = 0;
	const code = listModels({ search: "xyzzy-nothing-matches", stdout: write });
	assert.equal(code, 1);
});

// 5. thinking items
run("buildThinkingItems: marks current", () => {
	const items = buildThinkingItems("high");
	assert.equal(items.length, VALID_THINKING_LEVELS.length);
	assert.ok(items[4].label.includes("●"));
});

// 6. scoped model items
run("buildScopedModelItems: marks scoped entries", () => {
	const items = buildScopedModelItems(["openai/gpt-5"]);
	const gpt5 = items.find((i) => i.value === "openai/gpt-5");
	assert.ok(gpt5);
	assert.ok(gpt5.label.startsWith("[x]"));
});

// 7. model items (providers contract stub)
run("buildModelItems: renders at least one item per baked provider", () => {
	const stub = {
		list: () => [],
	} as any;
	const items = buildModelItems({ settings: DEFAULT_SETTINGS as ClioSettings, providers: stub });
	assert.ok(items.length > 0);
});

// 8. setting items + apply
run("applySettingChange: budget.concurrency numeric", () => {
	const s = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	applySettingChange(s, "budget.concurrency", "4");
	assert.equal(s.budget.concurrency, 4);
});
run("applySettingChange: orchestrator.thinkingLevel", () => {
	const s = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	applySettingChange(s, "orchestrator.thinkingLevel", "medium");
	assert.equal(s.orchestrator.thinkingLevel, "medium");
});
run("buildSettingItems: renders every category once", () => {
	const items = buildSettingItems(DEFAULT_SETTINGS as ClioSettings);
	const cats = new Set(items.map((i) => i.category));
	for (const c of ["General", "Budget", "Orchestrator", "Workers", "Scope"]) {
		assert.ok(cats.has(c), `missing category ${c}`);
	}
});

// 9. session items
run("buildSessionItems: handles empty", () => {
	assert.deepEqual(buildSessionItems([]), []);
});

// 10. hotkeys
run("formatHotkeysLines: contains every entry", () => {
	const lines = formatHotkeysLines();
	for (const hk of HOTKEYS) {
		assert.ok(lines.some((l) => l.includes(hk.keys)), `missing ${hk.keys}`);
	}
});

// 11. keybindings
run("routeInteractiveKey: Shift+Tab triggers cycleThinking", () => {
	let called = false;
	routeInteractiveKey(SHIFT_TAB, {
		cycleMode: () => {},
		cycleThinking: () => { called = true; },
		openModelSelector: () => {},
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
		cycleScopedModelForward: () => {},
		cycleScopedModelBackward: () => {},
	});
	assert.equal(called, true);
});
run("routeInteractiveKey: Alt+M triggers cycleMode", () => {
	let called = false;
	routeInteractiveKey(ALT_M, {
		cycleMode: () => { called = true; },
		cycleThinking: () => {},
		openModelSelector: () => {},
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
		cycleScopedModelForward: () => {},
		cycleScopedModelBackward: () => {},
	});
	assert.equal(called, true);
});
run("routeInteractiveKey: Ctrl+L triggers openModelSelector", () => {
	let called = false;
	routeInteractiveKey(CTRL_L, {
		cycleMode: () => {},
		cycleThinking: () => {},
		openModelSelector: () => { called = true; },
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
		cycleScopedModelForward: () => {},
		cycleScopedModelBackward: () => {},
	});
	assert.equal(called, true);
});
run("routeInteractiveKey: Ctrl+D triggers shutdown", () => {
	let called = false;
	routeInteractiveKey(CTRL_D, {
		cycleMode: () => {},
		cycleThinking: () => {},
		openModelSelector: () => {},
		requestShutdown: () => { called = true; },
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
		cycleScopedModelForward: () => {},
		cycleScopedModelBackward: () => {},
	});
	assert.equal(called, true);
});
run("routeInteractiveKey: Ctrl+B toggles dispatch board", () => {
	let called = false;
	routeInteractiveKey(CTRL_B, {
		cycleMode: () => {},
		cycleThinking: () => {},
		openModelSelector: () => {},
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => { called = true; },
		cycleScopedModelForward: () => {},
		cycleScopedModelBackward: () => {},
	});
	assert.equal(called, true);
});

// 12. slash parser
run("parseSlashCommand: /thinking", () => {
	assert.deepEqual(parseSlashCommand("/thinking"), { kind: "thinking" });
});
run("parseSlashCommand: /model", () => {
	assert.deepEqual(parseSlashCommand("/model"), { kind: "model" });
});
run("parseSlashCommand: /scoped-models", () => {
	assert.deepEqual(parseSlashCommand("/scoped-models"), { kind: "scoped-models" });
});
run("parseSlashCommand: /settings", () => {
	assert.deepEqual(parseSlashCommand("/settings"), { kind: "settings" });
});
run("parseSlashCommand: /resume", () => {
	assert.deepEqual(parseSlashCommand("/resume"), { kind: "resume" });
});
run("parseSlashCommand: /new", () => {
	assert.deepEqual(parseSlashCommand("/new"), { kind: "new" });
});
run("parseSlashCommand: /hotkeys", () => {
	assert.deepEqual(parseSlashCommand("/hotkeys"), { kind: "hotkeys" });
});

process.stdout.write("[diag-selectors] all checks ok\n");
```

### Step 12.2 — Add `diag:selectors` npm script

- [ ] In `package.json` scripts block, add:

```
"diag:selectors": "tsx scripts/diag-selectors.ts",
```

### Step 12.3 — Run diag

- [ ] `npm run diag:selectors`
- [ ] Expected: every line `[diag-selectors] ok  <name>` ending with `[diag-selectors] all checks ok` and exit code 0.
- [ ] If a check fails, fix the underlying code (not the diag), rerun.

### Step 12.4 — Include in CI chain

- [ ] Locate the `"ci"` npm script in `package.json`. Append `&& npm run diag:selectors` after the existing `&& npm run smoke` (or whatever the last step is). Verify `npm run ci` completes green.

### Step 12.5 — Commit

- [ ] `git add scripts/diag-selectors.ts package.json`
- [ ] `git commit -m "test(selectors): add diag-selectors covering Phase 11 surface"`

---

## Task 13 — Verify, Update CHANGELOG, Final commit

### Step 13.1 — Full verification chain

- [ ] `npm run ci` — full pipeline green.
- [ ] Manual TUI drill (may require TTY): `CLIO_HOME=$(mktemp -d) node dist/cli/index.js`. Exercise each new overlay/slash command.

### Step 13.2 — CHANGELOG entry

- [ ] Open `CHANGELOG.md`. Under `[Unreleased]`, add:

```md
## [Unreleased]

### Added (Phase 11: TUI Selector Suite)

- `/thinking` overlay + `Shift+Tab` cycles thinking level (off | minimal | low | medium | high | xhigh). Level persists to `orchestrator.thinkingLevel`.
- `/model` overlay + `Ctrl+L` opens a grouped model picker with health + cost + scope markers; selection writes `orchestrator.{provider,model,endpoint}`.
- `/scoped-models` overlay edits `provider.scope` (ordered list of model patterns); `Ctrl+P` / `Shift+Ctrl+P` cycle through resolved scope.
- `/settings` overlay edits common settings inline (mode, safety level, budget, orchestrator target, worker target, scope).
- `/resume` overlay lists sessions for the current cwd; Enter resumes.
- `/new` starts a fresh session.
- `/hotkeys` overlay lists every global / editor / overlay keybinding.
- `Alt+M` reassigned as the mode-cycle binding (was `Shift+Tab`); `Shift+Tab` now cycles thinking level.
- `clio --list-models [search]` headless command dumps (or filters) the provider catalog.

### Changed

- `DEFAULT_SETTINGS` adds `provider.scope: string[]` and `orchestrator.thinkingLevel` / `workers.default.thinkingLevel` (all optional; existing settings files load unchanged).
```

### Step 13.3 — Commit and tag

- [ ] `git add CHANGELOG.md`
- [ ] `git commit -m "docs(changelog): Phase 11 selectors complete"`

---

## Self-review

### Spec coverage (against port plan §2 and §4 Phase 11)

- [x] `src/interactive/overlays/model-selector.ts` → Task 6
- [x] `src/interactive/overlays/scoped-models.ts` → Task 5
- [x] `src/interactive/overlays/thinking-selector.ts` → Task 4
- [x] `src/interactive/overlays/settings.ts` → Task 7
- [x] `src/interactive/overlays/session-selector.ts` → Task 8
- [x] `src/interactive/overlays/message-picker.ts` → **deferred to Phase 12** (depends on session.listMessages() which doesn't exist yet and requires session-tree overhaul). Noted in Task 8.
- [x] `src/interactive/overlays/hotkeys.ts` → Task 9
- [x] `src/cli/list-models.ts` → Task 2
- [x] `src/domains/providers/resolver.ts` → Task 1
- [x] Slash commands `/model`, `/scoped-models`, `/thinking`, `/settings`, `/resume`, `/new`, `/hotkeys` → Tasks 4–9
- [x] Keybindings `Ctrl+L`, `Ctrl+P`, `Shift+Ctrl+P`, `Shift+Tab`, `Alt+M` → Tasks 4, 6, 10
- [x] Exit criteria: diag-selectors covers every pure function; manual TUI drill validates interaction.

### Placeholder scan

- No "TBD" / "figure out" / "similar to Task N" in the plan. Every step contains executable code or explicit validation commands.

### Type consistency

- `ThinkingLevel` type name and export path consistent (`src/domains/providers/resolver.ts`) across resolver, thinking overlay, chat-loop, settings schema, settings overlay.
- `OverlayState` additions checked against every `overlayState = "..."` assignment in `index.ts`.
- `SlashCommand` union additions checked against every case in the `editor.onSubmit` switch.
- `KeyBindingDeps` new fields consumed in every `routeInteractiveKey` unit call in the diag.

### Deferred from Phase 11 (carries to Phase 12)

- Message-picker overlay (needs `session.listMessages()`).
- Session-selector-search overlay (fuzzy filter UI; Phase 12 adds it because session tree lands there).
- Full `/tree` navigator (Phase 12; depends on session tree/fork work).
- `Ctrl+O` toggle tool output and `Ctrl+T` toggle thinking blocks (Phase 19 renderers).

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a subagent per task (Task 1, Task 2, …, Task 13), review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in-session with checkpoints. Use `superpowers:executing-plans`.

Next action (either path): begin Task 1 (provider model resolver).
