/**
 * React rendering of Clio Coder's Markdown from marked tokens.
 *
 * Every node is created by React from token data, so nothing the model writes
 * is interpreted as HTML. Diagrams and math insert only renderer output
 * sanitized by DOMPurify; see mermaid.ts and MathContent.tsx for the policy.
 */

import type { Tokens } from "marked";
import type { ReactNode, RefObject } from "react";
import * as React from "react";

const { createContext, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

import { type HighlightToken, highlightCode } from "./highlight.js";
import {
	codeLanguage,
	HIGHLIGHT_MAX_CHARS,
	IncrementalMarkdown,
	lexMarkdown,
	type MarkdownToken,
	type MathToken,
	mermaidSourceProblem,
	numericColumns,
	safeHref,
	tableText,
	tokenText,
} from "./markdown-model.js";
import { type MermaidResult, mermaidThemeKey, renderMermaid, subscribeMermaidTheme } from "./mermaid.js";

const MathContent = React.lazy(() => import("./MathContent.js"));

function MathTokenContent({ token }: { token: MathToken }) {
	return (
		<React.Suspense fallback={token.raw}>
			<MathContent token={token} />
		</React.Suspense>
	);
}

const ENTITY_PATTERN =
	/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp|copy|reg|hellip|mdash|ndash|rarr|larr|times);/giu;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	rarr: "→",
	larr: "←",
	times: "×",
};

/** Markdown entity references survive lexing verbatim; React must show the character. */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(ENTITY_PATTERN, (match, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower.startsWith("#x")) {
			const code = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		if (lower.startsWith("#")) {
			const code = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[lower] ?? match;
	});
}

/** Raster images only: an SVG can carry script, and the app draws nothing it would have to sanitize. */
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/u;
const INLINE_IMAGE_MAX_CHARS = 4 * 1024 * 1024;

const viewportObservers = new Map<string, { observer: IntersectionObserver; targets: Map<Element, Set<() => void>> }>();

function observeNearViewport(element: Element, rootMargin: string, notify: () => void): () => void {
	let pool = viewportObservers.get(rootMargin);
	if (pool === undefined) {
		const targets = new Map<Element, Set<() => void>>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const callbacks = targets.get(entry.target);
					targets.delete(entry.target);
					observer.unobserve(entry.target);
					if (callbacks) for (const callback of callbacks) callback();
				}
				if (targets.size === 0) {
					observer.disconnect();
					if (viewportObservers.get(rootMargin)?.observer === observer) viewportObservers.delete(rootMargin);
				}
			},
			{ rootMargin },
		);
		pool = { observer, targets };
		viewportObservers.set(rootMargin, pool);
	}
	const callbacks = pool.targets.get(element) ?? new Set<() => void>();
	callbacks.add(notify);
	pool.targets.set(element, callbacks);
	pool.observer.observe(element);
	return () => {
		callbacks.delete(notify);
		if (callbacks.size === 0) {
			pool.targets.delete(element);
			pool.observer.unobserve(element);
		}
		if (pool.targets.size === 0) {
			pool.observer.disconnect();
			if (viewportObservers.get(rootMargin) === pool) viewportObservers.delete(rootMargin);
		}
	};
}

/** True once near the viewport. Code and diagrams share one observer per margin. */
export function useNearViewport(ref: RefObject<HTMLElement | null>, rootMargin = "600px"): boolean {
	const [near, setNear] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (element === null || near) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		return observeNearViewport(element, rootMargin, () => setNear(true));
	}, [ref, near, rootMargin]);
	return near;
}

function fallbackCopy(text: string): boolean {
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const copied = document.execCommand("copy");
		area.remove();
		return copied;
	} catch {
		return false;
	}
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	async function copy(): Promise<void> {
		let next: "copied" | "failed" = "failed";
		try {
			await navigator.clipboard.writeText(text);
			next = "copied";
		} catch {
			next = fallbackCopy(text) ? "copied" : "failed";
		}
		setState(next);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), 1_600);
	}
	return (
		<button
			type="button"
			className={`code-block__copy is-${state}`}
			onClick={() => void copy()}
			aria-label={state === "copied" ? "Copied to the clipboard" : state === "failed" ? "Copy failed" : label}
		>
			{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
		</button>
	);
}

function HighlightedCode({ tokens }: { tokens: readonly HighlightToken[] }) {
	return (
		<>
			{tokens.map((token) =>
				token.type === null ? (
					typeof token.content === "string" ? (
						token.content
					) : (
						<HighlightedCode tokens={token.content} key={highlightKey(token)} />
					)
				) : (
					<span className={`token ${token.type}`} key={highlightKey(token)}>
						{typeof token.content === "string" ? token.content : <HighlightedCode tokens={token.content} />}
					</span>
				),
			)}
		</>
	);
}

/**
 * Lines a code block shows before it scrolls, from the `pre`'s 520px cap at 12px/1.7 mono. A block
 * that fits says nothing about its length; a longer one names it, because its end is out of sight.
 */
const CODE_VISIBLE_LINES = 24;
/** A line past this many characters runs off a reading column, so the block offers to wrap. */
const CODE_WRAP_OFFER_CHARS = 88;

function hasLongLine(code: string): boolean {
	let start = 0;
	while (start <= code.length) {
		const end = code.indexOf("\n", start);
		if ((end < 0 ? code.length : end) - start > CODE_WRAP_OFFER_CHARS) return true;
		if (end < 0) return false;
		start = end + 1;
	}
	return false;
}

interface CodeBlockProps {
	readonly code: string;
	readonly info: string | undefined;
	/** False while this block is still the streaming tail; highlighting waits for true. */
	readonly settled: boolean;
}

export const CodeBlock = memo(function CodeBlock({ code, info, settled }: CodeBlockProps) {
	const language = codeLanguage(info);
	const container = useRef<HTMLDivElement>(null);
	const near = useNearViewport(container);
	const [highlight, setHighlight] = useState<{
		code: string;
		grammar: string;
		tokens: readonly HighlightToken[] | null;
	} | null>(null);
	const grammar = language.grammar;
	const wantsHighlight = settled && near && grammar !== null && code.length <= HIGHLIGHT_MAX_CHARS;
	useEffect(() => {
		if (!wantsHighlight || grammar === null) return;
		let cancelled = false;
		void highlightCode(code, grammar).then((result) => {
			if (!cancelled) setHighlight({ code, grammar, tokens: result });
		});
		return () => {
			cancelled = true;
		};
	}, [wantsHighlight, code, grammar]);
	const tokens = highlight?.code === code && highlight.grammar === grammar ? highlight.tokens : null;
	const lineCount = code.length === 0 ? 0 : code.split("\n").length;
	const [wrap, setWrap] = useState(false);
	// Offered once the block has settled, so the control does not appear and vanish while it streams.
	const wrappable = useMemo(() => settled && hasLongLine(code), [settled, code]);
	return (
		<div
			className={`code-block${settled ? " is-settled" : " is-streaming"}`}
			ref={container}
			data-language={grammar ?? undefined}
			data-wrap={wrap && wrappable ? "" : undefined}
		>
			<div className="code-block__head">
				<span className="code-block__lang">{language.label ?? "text"}</span>
				{lineCount > CODE_VISIBLE_LINES ? <span className="code-block__lines">{lineCount} lines</span> : null}
				{wrappable ? (
					<button
						type="button"
						className="code-block__copy"
						aria-pressed={wrap}
						title="Wrap long lines inside the block instead of scrolling sideways"
						onClick={() => setWrap((current) => !current)}
					>
						Wrap
					</button>
				) : null}
				<CopyButton text={code} />
			</div>
			<CodeViewport>
				<code className={grammar === null ? undefined : `language-${grammar}`}>
					{tokens === null ? code : <HighlightedCode tokens={tokens} />}
					{settled ? null : <span className="code-block__cursor" aria-hidden="true" />}
				</code>
			</CodeViewport>
		</div>
	);
});

interface MermaidBlockProps {
	readonly source: string;
	readonly settled: boolean;
}

/**
 * True while the surrounding turn is still streaming. Mermaid lays a diagram
 * out in one synchronous main-thread task (a 76 ms microtask checkpoint was
 * traced for a seven-node flowchart), so diagrams wait for the whole response
 * to settle rather than landing between text frames.
 */
const StreamingContext = createContext(false);

export const MermaidBlock = memo(function MermaidBlock({ source, settled }: MermaidBlockProps) {
	const container = useRef<HTMLElement>(null);
	const near = useNearViewport(container);
	const streaming = useContext(StreamingContext);
	const [rendered, setRendered] = useState<{ source: string; result: MermaidResult } | null>(null);
	const result = rendered?.source === source ? rendered.result : null;
	const [showSource, setShowSource] = useState(false);
	// Offered only when the drawing is wider than its column, which is when fitting it shrinks the labels.
	const [shrunk, setShrunk] = useState(false);
	const [fullSize, setFullSize] = useState(false);
	const problem = mermaidSourceProblem(source);
	const wantsRender = settled && !streaming && near && problem === null;
	// Mermaid bakes its colours into the drawing, so a theme change draws it again from the new tokens.
	const themeKey = useSyncExternalStore(subscribeMermaidTheme, mermaidThemeKey, () => "");
	useEffect(() => {
		if (!wantsRender) return;
		let cancelled = false;
		void renderMermaid(source).then((rendered) => {
			if (!cancelled) setRendered({ source, result: rendered });
		});
		return () => {
			cancelled = true;
		};
	}, [wantsRender, source, themeKey]);
	const state =
		!settled || streaming
			? "pending"
			: problem !== null
				? "bounded"
				: result === null
					? "rendering"
					: result.ok
						? "rendered"
						: "failed";
	const status =
		state === "pending"
			? "The diagram renders once this response settles."
			: state === "bounded"
				? problem
				: state === "rendering"
					? "Rendering the diagram…"
					: state === "failed" && result !== null && !result.ok
						? `Mermaid could not render this diagram: ${result.error}`
						: null;
	const sourceVisible = state !== "rendered" || showSource;
	return (
		<figure
			className={`diagram is-${state}`}
			ref={container}
			aria-label="Mermaid diagram"
			data-zoom={state === "rendered" && fullSize && shrunk ? "" : undefined}
		>
			<div className="code-block__head">
				<span className="code-block__lang">mermaid</span>
				{state === "rendered" && shrunk && (
					<button
						type="button"
						className="code-block__copy"
						aria-pressed={fullSize}
						title="Draw the diagram at its own size and scroll it, instead of shrinking it to the column"
						onClick={() => setFullSize((current) => !current)}
					>
						Full size
					</button>
				)}
				{state === "rendered" && (
					<button
						type="button"
						className="code-block__copy"
						aria-pressed={showSource}
						onClick={() => setShowSource((current) => !current)}
					>
						{showSource ? "Hide source" : "Show source"}
					</button>
				)}
				<CopyButton text={source} label="Copy source" />
			</div>
			{state === "rendered" && result !== null && result.ok && (
				// Strict Mermaid output is sanitized by DOMPurify before DOM import.
				<SanitizedDiagram svg={result.svg} onShrunk={setShrunk} />
			)}
			{sourceVisible && (
				<CodeViewport>
					<code className="language-mermaid">{source}</code>
				</CodeViewport>
			)}
			{status !== null && (
				// A figcaption may not carry a live-region role, so the words it announces sit inside it.
				<figcaption className="diagram__status">
					<span role={state === "failed" ? "alert" : "status"}>{status}</span>
				</figcaption>
			)}
		</figure>
	);
});

function headingTag(depth: number): "h2" | "h3" | "h4" | "h5" | "h6" {
	const level = Math.min(6, Math.max(2, depth + 1));
	return `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
}

function Inline({ tokens }: { tokens: readonly MarkdownToken[] }) {
	return (
		<>
			{tokens.map((token, index) => (
				<InlineToken token={token} key={tokenKey(index, token.type)} />
			))}
		</>
	);
}

function InlineToken({ token }: { token: MarkdownToken }): ReactNode {
	switch (token.type) {
		case "math":
			return <MathTokenContent token={token as MathToken} />;
		case "text": {
			const text = token as Tokens.Text;
			if (text.tokens !== undefined && text.tokens.length > 0) return <Inline tokens={text.tokens} />;
			return decodeEntities(text.text);
		}
		case "escape":
			return (token as Tokens.Escape).text;
		case "strong":
			return (
				<strong>
					<Inline tokens={(token as Tokens.Strong).tokens} />
				</strong>
			);
		case "em":
			return (
				<em>
					<Inline tokens={(token as Tokens.Em).tokens} />
				</em>
			);
		case "del":
			return (
				<del>
					<Inline tokens={(token as Tokens.Del).tokens} />
				</del>
			);
		case "codespan":
			return <code>{(token as Tokens.Codespan).text}</code>;
		case "br":
			return <br />;
		case "link": {
			const link = token as Tokens.Link;
			const href = safeHref(link.href);
			if (href === null) {
				return (
					<span className="md-link md-link--blocked" title="This link was not activated: unsupported destination">
						<Inline tokens={link.tokens} />
					</span>
				);
			}
			return (
				<a className="md-link" href={href} target="_blank" rel="noopener noreferrer" title={link.title ?? undefined}>
					<Inline tokens={link.tokens} />
				</a>
			);
		}
		case "image": {
			const image = token as Tokens.Image;
			// A picture carried in the text itself is drawn: nothing is fetched to show it. One that
			// lives elsewhere is never loaded by the app; it becomes a link the operator may follow.
			if (INLINE_IMAGE.test(image.href) && image.href.length <= INLINE_IMAGE_MAX_CHARS)
				return <img className="md-picture" src={image.href} alt={image.text} loading="lazy" decoding="async" />;
			const label = `image${image.text.length > 0 ? `: ${image.text}` : ""}`;
			const href = safeHref(image.href);
			return href === null ? (
				<span className="md-image" title="This image is not loaded: unsupported address">
					[{label}]
				</span>
			) : (
				<a
					className="md-image md-link"
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					title="Clio Coder does not load images from other places. Open this one in the browser."
				>
					[{label}]
				</a>
			);
		}
		case "checkbox":
			return (
				<input
					type="checkbox"
					className="md-task"
					checked={(token as Tokens.Checkbox).checked}
					readOnly
					disabled
					aria-label={(token as Tokens.Checkbox).checked ? "Done" : "Not done"}
				/>
			);
		case "html":
			return <span className="md-html">{(token as Tokens.HTML).text}</span>;
		case "space":
			return null;
		default: {
			const generic = token as Tokens.Generic;
			if (Array.isArray(generic.tokens)) return <Inline tokens={generic.tokens} />;
			return typeof generic.text === "string" ? generic.text : generic.raw;
		}
	}
}

function ListItems({ items, settled }: { items: readonly Tokens.ListItem[]; settled: boolean }) {
	return (
		<>
			{items.map((item, index) => (
				<li className={item.task ? "md-task-item" : undefined} key={tokenKey(index, item.type)}>
					<Blocks tokens={item.tokens} settled={settled} />
				</li>
			))}
		</>
	);
}

const Block = memo(function Block({ token, settled }: { token: MarkdownToken; settled: boolean }): ReactNode {
	switch (token.type) {
		case "math":
			return <MathTokenContent token={token as MathToken} />;
		case "space":
		case "def":
			return null;
		case "heading": {
			const heading = token as Tokens.Heading;
			const Tag = headingTag(heading.depth);
			return (
				<Tag className={`md-heading md-heading--${heading.depth}`}>
					<Inline tokens={heading.tokens} />
				</Tag>
			);
		}
		case "paragraph":
			return (
				<p>
					<Inline tokens={(token as Tokens.Paragraph).tokens} />
				</p>
			);
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens !== undefined && text.tokens.length > 0 ? (
				<Inline tokens={text.tokens} />
			) : (
				decodeEntities(text.text)
			);
		}
		case "list": {
			const list = token as Tokens.List;
			const className = list.items.some((item) => item.task) ? "md-list md-list--tasks" : "md-list";
			if (list.ordered) {
				return (
					<ol className={className} start={typeof list.start === "number" && list.start !== 1 ? list.start : undefined}>
						<ListItems items={list.items} settled={settled} />
					</ol>
				);
			}
			return (
				<ul className={className}>
					<ListItems items={list.items} settled={settled} />
				</ul>
			);
		}
		case "blockquote":
			return (
				<blockquote>
					<Blocks tokens={(token as Tokens.Blockquote).tokens} settled={settled} />
				</blockquote>
			);
		case "code": {
			const code = token as Tokens.Code;
			if (codeLanguage(code.lang).mermaid) return <MermaidBlock source={code.text} settled={settled} />;
			return <CodeBlock code={code.text} info={code.lang} settled={settled} />;
		}
		case "table":
			return <TableBlock table={token as Tokens.Table} settled={settled} />;
		case "hr":
			return <hr />;
		case "html": {
			const html = (token as Tokens.HTML).text;
			return <p className="md-html">{html}</p>;
		}
		case "checkbox":
			// Task items carry their checkbox as a block-level token before the text.
			return <InlineToken token={token} />;
		default: {
			const generic = token as Tokens.Generic;
			if (Array.isArray(generic.tokens)) {
				return (
					<p>
						<Inline tokens={generic.tokens} />
					</p>
				);
			}
			return <p>{typeof generic.text === "string" ? generic.text : generic.raw}</p>;
		}
	}
});

/**
 * A table reads as data: a column of numbers is set right-aligned in tabular figures unless the
 * author aligned it, the header stays in view while a long table scrolls, and a settled table can
 * be copied as cells.
 */
function TableBlock({ table, settled }: { table: Tokens.Table; settled: boolean }) {
	const cells = useMemo(() => {
		const header = table.header.map((cell) => tokenText(cell.tokens));
		const rows = table.rows.map((row) => row.map((cell) => tokenText(cell.tokens)));
		return { header, rows, numeric: numericColumns(rows, header.length) };
	}, [table]);
	const cellProps = (align: Tokens.TableCell["align"], column: number) =>
		align ? { style: { textAlign: align } } : cells.numeric[column] ? { className: "md-table__number" } : {};
	return (
		<TableViewport
			action={
				settled && table.rows.length > 0 ? (
					<CopyButton text={tableText(cells.header, cells.rows)} label="Copy table" />
				) : null
			}
		>
			<table>
				<thead>
					<tr>
						{table.header.map((cell, index) => (
							<th scope="col" {...cellProps(cell.align, index)} key={tokenKey(index)}>
								<Inline tokens={cell.tokens} />
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{table.rows.map((row, index) => (
						<tr key={tokenKey(index)}>
							{row.map((cell, cellIndex) => (
								<td {...cellProps(cell.align, cellIndex)} key={tokenKey(cellIndex)}>
									<Inline tokens={cell.tokens} />
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</TableViewport>
	);
}

export const Blocks = memo(function Blocks({
	tokens,
	settled,
	settledCount = 0,
}: {
	tokens: readonly MarkdownToken[];
	settled: boolean;
	settledCount?: number;
}) {
	return (
		<>
			{tokens.map((token, index) => (
				<Block token={token} settled={settled || index < settledCount} key={tokenKey(index, token.type)} />
			))}
		</>
	);
});

interface MarkdownContentProps {
	readonly source: string;
	/** True once the narrative can no longer grow; the whole source is then lexed once, canonically. */
	readonly complete: boolean;
	/**
	 * Keeps diagrams pending after this narrative completes, for a turn that is
	 * still streaming later items: Clio Coder finishes a narrative before every
	 * tool burst, so per-item completion is not a quiet moment.
	 */
	readonly deferDiagrams?: boolean;
}

/**
 * One narrative. While streaming, settled blocks keep their token identity and
 * only the tail after the last block boundary is re-lexed each frame.
 */
export const MarkdownContent = memo(function MarkdownContent({
	source,
	complete,
	deferDiagrams = false,
}: MarkdownContentProps) {
	const incremental = useRef<IncrementalMarkdown | null>(null);
	const split = useMemo(() => {
		if (complete) return null;
		incremental.current ??= new IncrementalMarkdown();
		return incremental.current.update(source);
	}, [source, complete]);
	const finalTokens = useMemo(() => {
		if (!complete) return null;
		const tokens = lexMarkdown(source);
		// The canonical parse replaces the streaming lexer; settled messages need
		// neither its second token tree nor its retained source and tail strings.
		incremental.current = null;
		return tokens;
	}, [source, complete]);
	const tokens = useMemo(
		() => finalTokens ?? [...(split?.settled ?? NO_TOKENS), ...(split?.tail ?? NO_TOKENS)],
		[finalTokens, split],
	);
	return (
		<StreamingContext.Provider value={finalTokens === null || deferDiagrams}>
			<div className={`markdown ${finalTokens === null ? "is-streaming" : "is-complete"}`}>
				{/* One child list keeps a growing block mounted when it joins the settled prefix. */}
				<Blocks tokens={tokens} settled={complete} settledCount={split?.settled.length ?? 0} />
			</div>
		</StreamingContext.Provider>
	);
});

const NO_TOKENS: readonly MarkdownToken[] = [];

/**
 * A table wider than its column scrolls inside this wrapper. A scrolling region has to take focus
 * so the keyboard can move it, but a table that fits should not add a Tab stop, so focus and the
 * label follow the measured overflow. Sections that are closed measure zero and update on opening.
 */
function TableViewport({ children, action }: { children: ReactNode; action: ReactNode }) {
	const wrapper = useRef<HTMLDivElement>(null);
	const [scrolls, setScrolls] = useState(false);
	useEffect(() => {
		const element = wrapper.current;
		if (!element) return;
		const measure = () => setScrolls(element.scrollWidth > element.clientWidth + 1);
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		if (observer !== null) {
			observer.observe(element);
			if (element.firstElementChild) observer.observe(element.firstElementChild);
			return () => observer.disconnect();
		}
		// A browser without ResizeObserver can still render and keyboard-scroll wide tables.
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);
	// Name and focus the scroll container without adding a page landmark for every table.
	const scrolling = scrolls ? ({ tabIndex: 0, role: "group", "aria-label": "Scrollable table" } as const) : {};
	return (
		<div className="md-table-frame">
			<div className="md-table" ref={wrapper} {...scrolling}>
				{children}
			</div>
			{action === null ? null : <div className="md-table__action">{action}</div>}
		</div>
	);
}

function CodeViewport({ children }: { children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: This overflowing code viewport must accept keyboard focus so arrow keys can scroll it; the browser smoke proves that behavior.
		<pre tabIndex={0}>{children}</pre>
	);
}

/**
 * The lexer recreates the growing tail on every update. Its ordered syntax slots,
 * rather than token object identities, keep text, code and table DOM mounted as
 * that tail grows. A change of syntax kind still replaces the affected subtree.
 * Settled tokens also retain their object identity, so Block can skip their work.
 */
function tokenKey(index: number, type = "item"): string {
	return `${type}:${index}`;
}

// Highlight tokens are immutable and only replaced after a new highlighting result.
const highlightKeys = new WeakMap<object, number>();
let nextHighlightKey = 0;
function highlightKey(token: object) {
	let key = highlightKeys.get(token);
	if (key === undefined) {
		key = ++nextHighlightKey;
		highlightKeys.set(token, key);
	}
	return key;
}
/** Only renderMermaid's sanitized SVG enters this sink; model Markdown always uses React text nodes. */
function SanitizedDiagram({ svg, onShrunk }: { svg: string; onShrunk: (shrunk: boolean) => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		const document = new DOMParser().parseFromString(svg, "image/svg+xml");
		if (document.documentElement.localName !== "svg") return;
		root.replaceChildren(root.ownerDocument.importNode(document.documentElement, true));
		let cancelled = false;
		let observer: ResizeObserver | null = null;
		// Some Mermaid layouts compute a viewBox before translated nodes settle.
		// Fit the sanitized, mounted drawing once, after local fonts are ready.
		void root.ownerDocument.fonts.ready.then(() => {
			if (cancelled) return;
			const drawing = root.querySelector("svg");
			if (!drawing) return;
			const box = drawing.getBBox();
			if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return;
			drawing.setAttribute("viewBox", `${box.x - 8} ${box.y - 8} ${box.width + 16} ${box.height + 16}`);
			const natural = box.width + 16;
			drawing.style.setProperty("--diagram-width", `${natural}px`);
			// The canvas pads 16px a side; a drawing wider than what is left is being scaled down.
			const measure = () => onShrunk(natural > root.clientWidth - 32 + 1);
			measure();
			if (typeof ResizeObserver !== "undefined") {
				observer = new ResizeObserver(measure);
				observer.observe(root);
			}
		});
		return () => {
			cancelled = true;
			observer?.disconnect();
			root.replaceChildren();
		};
	}, [svg, onShrunk]);
	return <div className="diagram__canvas" ref={ref} />;
}
