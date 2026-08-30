/**
 * Lazy, strict Mermaid rendering.
 *
 * Mermaid and DOMPurify load as their own chunk the first time a settled,
 * in-bounds diagram scrolls near the viewport. Mermaid runs at securityLevel
 * "strict" with SVG-only labels, and the SVG it returns is sanitized again on
 * the way out: no foreignObject, no anchors, no images, no event attributes.
 * A diagram that fails to parse or render reports the failure as text.
 */

import { mermaidSourceProblem } from "./markdown.ts";

export type MermaidResult =
	| Readonly<{ ok: true; svg: string }>
	| Readonly<{ ok: false; error: string }>;

interface MermaidLike {
	initialize(config: Record<string, unknown>): void;
	parse(text: string, options?: { suppressErrors?: boolean }): Promise<unknown>;
	render(id: string, text: string): Promise<{ svg: string }>;
}

interface SanitizerLike {
	sanitize(dirty: string, config: Record<string, unknown>): string;
}

const THEME_VARIABLES = {
	background: "transparent",
	fontFamily: '"Atkinson Hyperlegible Next Variable", "Segoe UI", sans-serif',
	fontSize: "13px",
	primaryColor: "#10161d",
	primaryTextColor: "#dce5e5",
	primaryBorderColor: "#2aab9e",
	secondaryColor: "#151d25",
	secondaryTextColor: "#dce5e5",
	secondaryBorderColor: "#2f5d5a",
	tertiaryColor: "#0c1117",
	tertiaryTextColor: "#dce5e5",
	tertiaryBorderColor: "#2f5d5a",
	lineColor: "#1fb7a6",
	textColor: "#dce5e5",
	mainBkg: "#10161d",
	nodeBorder: "#2aab9e",
	clusterBkg: "#0c1117",
	clusterBorder: "#2f5d5a",
	titleColor: "#f4f7f6",
	edgeLabelBackground: "#090d12",
	actorBkg: "#10161d",
	actorBorder: "#2aab9e",
	actorTextColor: "#dce5e5",
	signalColor: "#dce5e5",
	signalTextColor: "#dce5e5",
	labelBoxBkgColor: "#10161d",
	labelTextColor: "#dce5e5",
	noteBkgColor: "#151d25",
	noteTextColor: "#dce5e5",
	noteBorderColor: "#2f5d5a",
	errorBkgColor: "#2a1519",
	errorTextColor: "#ff5c66",
} as const;

/**
 * Mermaid's embedded stylesheet stays: it is scoped to the diagram id and the
 * page CSP keeps every url() it could name on this origin. Everything that
 * could navigate, embed, or run is removed.
 */
const SANITIZE_CONFIG = {
	USE_PROFILES: { svg: true, svgFilters: true },
	FORBID_TAGS: ["foreignObject", "script", "a", "image", "iframe", "object", "embed", "animate", "set"],
	FORBID_ATTR: ["href", "xlink:href", "onload", "onclick", "onerror", "onmouseover"],
} as const;

let loading: Promise<{ mermaid: MermaidLike; sanitizer: SanitizerLike }> | null = null;
let counter = 0;

function load(): Promise<{ mermaid: MermaidLike; sanitizer: SanitizerLike }> {
	if (loading === null) {
		loading = Promise.all([import("mermaid"), import("dompurify")]).then(([mermaidModule, purifyModule]) => {
			const mermaid = mermaidModule.default as unknown as MermaidLike;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				htmlLabels: false,
				flowchart: { htmlLabels: false, useMaxWidth: true },
				sequence: { useMaxWidth: true },
				gantt: { useMaxWidth: true },
				theme: "base",
				themeVariables: THEME_VARIABLES,
				fontFamily: THEME_VARIABLES.fontFamily,
				maxTextSize: 16_384,
				maxEdges: 400,
				suppressErrorRendering: true,
				deterministicIds: true,
				logLevel: "fatal",
			});
			const sanitizer = purifyModule.default as unknown as SanitizerLike;
			return { mermaid, sanitizer };
		});
		loading.catch(() => {
			loading = null;
		});
	}
	return loading;
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
