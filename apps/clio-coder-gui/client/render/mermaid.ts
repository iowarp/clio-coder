/**
 * Lazy, strict Mermaid rendering.
 *
 * Mermaid and DOMPurify load as their own chunk the first time a settled,
 * in-bounds diagram scrolls near the viewport. Mermaid runs at securityLevel
 * "strict" with SVG-only labels, and the SVG it returns is sanitized again on
 * the way out: no foreignObject, no anchors, no images, no event attributes.
 * A diagram that fails to parse or render reports the failure as text.
 */

import { mermaidSourceProblem } from "./markdown-model.js";
import { SANITIZE_CONFIG } from "./sanitize-policy.js";

export type MermaidResult = Readonly<{ ok: true; svg: string }> | Readonly<{ ok: false; error: string }>;

interface MermaidLike {
	initialize(config: Record<string, unknown>): void;
	parse(text: string, options?: { suppressErrors?: boolean }): Promise<unknown>;
	render(id: string, text: string): Promise<{ svg: string }>;
}

interface SanitizerLike {
	sanitize(dirty: string, config: Record<string, unknown>): string;
}

/**
 * Mermaid computes shades from its theme variables, so they must be concrete colours rather than CSS
 * variables. They are read from the token layer each time the theme changes: node fills on the code
 * surface, the brand accent for the rules a reader follows, the code gutter for secondary rules, and the
 * code ink for every label. A token that cannot be read is left out, so Mermaid keeps its own default
 * for it instead of this file carrying a colour of its own.
 */
const ROLE_TOKENS = {
	paper: "--code-paper",
	surface: "--code-surface",
	ink: "--code-ink",
	muted: "--code-ink-muted",
	edge: "--code-gutter",
	signal: "--accent",
	failFill: "--status-fail-tint",
	failInk: "--status-fail-fg",
} as const;

type Role = keyof typeof ROLE_TOKENS;
type Palette = Readonly<Partial<Record<Role, string>>>;

const FONT_FAMILY = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readPalette(): Palette {
	if (typeof document === "undefined") return {};
	const style = getComputedStyle(document.documentElement);
	const palette: Partial<Record<Role, string>> = {};
	for (const [role, token] of Object.entries(ROLE_TOKENS) as [Role, string][]) {
		const value = style.getPropertyValue(token).trim();
		if (value !== "") palette[role] = value;
	}
	return palette;
}

function themeVariables(palette: Palette): Record<string, string> {
	const { paper, surface, ink, muted, edge, signal, failFill, failInk } = palette;
	const roles: Record<string, string | undefined> = {
		primaryColor: surface,
		primaryTextColor: ink,
		primaryBorderColor: signal,
		secondaryColor: paper,
		secondaryTextColor: ink,
		secondaryBorderColor: edge,
		tertiaryColor: paper,
		tertiaryTextColor: ink,
		tertiaryBorderColor: edge,
		lineColor: muted,
		textColor: ink,
		mainBkg: surface,
		nodeBorder: signal,
		clusterBkg: paper,
		clusterBorder: edge,
		titleColor: ink,
		edgeLabelBackground: paper,
		actorBkg: surface,
		actorBorder: signal,
		actorTextColor: ink,
		signalColor: ink,
		signalTextColor: ink,
		labelBoxBkgColor: surface,
		labelTextColor: ink,
		noteBkgColor: paper,
		noteTextColor: ink,
		noteBorderColor: edge,
		errorBkgColor: failFill,
		errorTextColor: failInk,
	};
	const variables: Record<string, string> = { background: "transparent", fontFamily: FONT_FAMILY, fontSize: "13px" };
	for (const [name, value] of Object.entries(roles)) if (value !== undefined) variables[name] = value;
	return variables;
}

function mermaidConfig(palette: Palette): Record<string, unknown> {
	return {
		startOnLoad: false,
		securityLevel: "strict",
		htmlLabels: false,
		flowchart: { htmlLabels: false, useMaxWidth: true },
		sequence: { useMaxWidth: true },
		gantt: { useMaxWidth: true },
		theme: "base",
		themeVariables: themeVariables(palette),
		fontFamily: FONT_FAMILY,
		maxTextSize: 16_384,
		maxEdges: 400,
		suppressErrorRendering: true,
		deterministicIds: true,
		logLevel: "fatal",
	};
}

/** Names the theme the page is painting, so a drawn diagram can tell that its colours are stale. */
export function mermaidThemeKey(): string {
	if (typeof document === "undefined") return "";
	let dark = false;
	try {
		dark = window.matchMedia(DARK_QUERY).matches;
	} catch {
		// No media query support: the system preference reads as light, as it does in shell/theme.ts.
	}
	return `${document.documentElement.dataset.theme ?? "system"}|${dark ? "dark" : "light"}`;
}

/** Calls `listener` when the root's `data-theme` or the system colour preference changes. */
export function subscribeMermaidTheme(listener: () => void): () => void {
	const observer = new MutationObserver(listener);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	let query: MediaQueryList | undefined;
	try {
		query = window.matchMedia(DARK_QUERY);
		query.addEventListener("change", listener);
	} catch {
		// No media query support: only an explicit choice can change the theme.
	}
	return () => {
		observer.disconnect();
		query?.removeEventListener("change", listener);
	};
}

let loading: Promise<{ mermaid: MermaidLike; sanitizer: SanitizerLike }> | null = null;
let counter = 0;
let configuredFor = "";

function load(): Promise<{ mermaid: MermaidLike; sanitizer: SanitizerLike }> {
	if (loading === null) {
		loading = Promise.all([import("mermaid"), import("dompurify")]).then(([mermaidModule, purifyModule]) => {
			const mermaid = mermaidModule.default as unknown as MermaidLike;
			const sanitizer = purifyModule.default as unknown as SanitizerLike;
			return { mermaid, sanitizer };
		});
		loading.catch(() => {
			loading = null;
		});
	}
	return loading;
}

/** Mermaid bakes its colours into each drawing, so the config is rebuilt whenever the tokens differ. */
function configure(mermaid: MermaidLike): void {
	const palette = readPalette();
	const key = JSON.stringify(palette);
	if (key === configuredFor) return;
	mermaid.initialize(mermaidConfig(palette));
	configuredFor = key;
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Mermaid failed.";
	const firstLines = message.split("\n").slice(0, 4).join("\n").trim();
	return (firstLines.length === 0 ? "Mermaid could not render this diagram." : firstLines).slice(0, 400);
}

/**
 * Renders run one at a time with a macrotask between them, so several diagrams
 * settling together become several short tasks rather than one long one.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Renders `source` to sanitized SVG markup, or explains why it could not. */
export function renderMermaid(source: string): Promise<MermaidResult> {
	const problem = mermaidSourceProblem(source);
	if (problem !== null) return Promise.resolve({ ok: false, error: problem });
	const turn = queue.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).then(() => renderNow(source));
	queue = turn.catch(() => undefined);
	return turn;
}

async function renderNow(source: string): Promise<MermaidResult> {
	let runtime: { mermaid: MermaidLike; sanitizer: SanitizerLike };
	try {
		runtime = await load();
	} catch (error) {
		return { ok: false, error: `The diagram renderer could not load: ${describeError(error)}` };
	}
	try {
		configure(runtime.mermaid);
		await runtime.mermaid.parse(source);
		counter += 1;
		const { svg } = await runtime.mermaid.render(`clio-coder-diagram-${counter}`, source);
		const clean = runtime.sanitizer.sanitize(svg, SANITIZE_CONFIG);
		if (!clean.includes("<svg")) return { ok: false, error: "Mermaid returned no drawable SVG." };
		return { ok: true, svg: clean };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}
