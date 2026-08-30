/// <reference path="./prism-components.d.ts" />
/**
 * Lazy syntax highlighting. Prism's core and each grammar arrive as separate
 * chunks the first time a settled code block with that language scrolls near
 * the viewport. Only the token tree is used; Prism never writes HTML here.
 */

export interface HighlightToken {
	readonly type: string | null;
	readonly content: string | readonly HighlightToken[];
}

interface PrismToken {
	readonly type: string;
	readonly alias?: string | readonly string[];
	readonly content: string | ReadonlyArray<string | PrismToken>;
}

interface PrismLike {
	readonly languages: Record<string, unknown>;
	tokenize(text: string, grammar: unknown): ReadonlyArray<string | PrismToken>;
}

const GRAMMAR_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
	clike: () => import("prismjs/components/prism-clike"),
	javascript: () => import("prismjs/components/prism-javascript"),
	typescript: () => import("prismjs/components/prism-typescript"),
	markup: () => import("prismjs/components/prism-markup"),
	jsx: () => import("prismjs/components/prism-jsx"),
	tsx: () => import("prismjs/components/prism-tsx"),
	python: () => import("prismjs/components/prism-python"),
	bash: () => import("prismjs/components/prism-bash"),
	"shell-session": () => import("prismjs/components/prism-shell-session"),
	yaml: () => import("prismjs/components/prism-yaml"),
	markdown: () => import("prismjs/components/prism-markdown"),
	c: () => import("prismjs/components/prism-c"),
	cpp: () => import("prismjs/components/prism-cpp"),
	rust: () => import("prismjs/components/prism-rust"),
	go: () => import("prismjs/components/prism-go"),
	sql: () => import("prismjs/components/prism-sql"),
	diff: () => import("prismjs/components/prism-diff"),
	json: () => import("prismjs/components/prism-json"),
	toml: () => import("prismjs/components/prism-toml"),
	css: () => import("prismjs/components/prism-css"),
	docker: () => import("prismjs/components/prism-docker"),
	makefile: () => import("prismjs/components/prism-makefile"),
	latex: () => import("prismjs/components/prism-latex"),
	ini: () => import("prismjs/components/prism-ini"),
	r: () => import("prismjs/components/prism-r"),
	julia: () => import("prismjs/components/prism-julia"),
	matlab: () => import("prismjs/components/prism-matlab"),
	fortran: () => import("prismjs/components/prism-fortran"),
};

const GRAMMAR_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
	javascript: ["clike"],
	typescript: ["javascript"],
	jsx: ["markup", "javascript"],
	tsx: ["jsx", "typescript"],
	c: ["clike"],
	cpp: ["c"],
	go: ["clike"],
	markdown: ["markup"],
	"shell-session": ["bash"],
};

let core: Promise<PrismLike> | null = null;
const grammars = new Map<string, Promise<boolean>>();

function loadCore(): Promise<PrismLike> {
	if (core === null) {
		// Read by prism-core before it decides whether to scan the document.
		(globalThis as { Prism?: unknown }).Prism = { manual: true };
		core = import("prismjs/components/prism-core").then((module) => {
			const candidate = (module as { default?: unknown }).default ?? (globalThis as { Prism?: unknown }).Prism;
			if (typeof candidate !== "object" || candidate === null || !("tokenize" in candidate)) {
				throw new Error("Prism core did not load.");
			}
			return candidate as PrismLike;
		});
	}
	return core;
}

function loadGrammar(language: string): Promise<boolean> {
	const cached = grammars.get(language);
	if (cached !== undefined) return cached;
	const loader = GRAMMAR_LOADERS[language];
	if (loader === undefined) return Promise.resolve(false);
	const loading = (async () => {
		await loadCore();
		for (const dependency of GRAMMAR_DEPENDENCIES[language] ?? []) {
			if (!(await loadGrammar(dependency))) return false;
		}
		await loader();
		return true;
	})().catch(() => false);
	grammars.set(language, loading);
	return loading;
}

function normalize(tokens: ReadonlyArray<string | PrismToken>): HighlightToken[] {
	return tokens.map((token) => {
		if (typeof token === "string") return { type: null, content: token };
		const aliases = token.alias === undefined ? [] : typeof token.alias === "string" ? [token.alias] : token.alias;
		const type = [token.type, ...aliases].join(" ");
		return {
			type,
			content: typeof token.content === "string" ? token.content : normalize(token.content),
		};
	});
}

/** Highlighted tokens for `code`, or null when the grammar is unavailable or failed. */
export async function highlightCode(code: string, language: string): Promise<readonly HighlightToken[] | null> {
	if (!(await loadGrammar(language))) return null;
	const prism = await loadCore();
	const grammar = prism.languages[language];
	if (grammar === undefined) return null;
	try {
		return normalize(prism.tokenize(code, grammar));
	} catch {
		return null;
	}
}

export function isHighlightable(language: string): boolean {
	return language in GRAMMAR_LOADERS;
}
