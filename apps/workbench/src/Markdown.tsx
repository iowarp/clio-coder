/**
 * React rendering of Clio Coder's Markdown from marked tokens.
 *
 * Every node is created by React from token data, so nothing the model writes
 * is interpreted as HTML. The single exception is the Mermaid figure, which
 * inserts SVG that strict Mermaid produced and DOMPurify sanitized; see
 * mermaid.ts for the policy.
 */

import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Tokens } from "marked";
import { highlightCode, type HighlightToken } from "./highlight.ts";
import {
	codeLanguage,
	HIGHLIGHT_MAX_CHARS,
	IncrementalMarkdown,
	lexMarkdown,
	type MarkdownToken,
	mermaidSourceProblem,
	safeHref,
} from "./markdown.ts";
import { type MermaidResult, renderMermaid } from "./mermaid.ts";

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

/** True once the element is within `rootMargin` of the viewport; false before mount and on the server. */
export function useNearViewport(ref: RefObject<HTMLElement | null>, rootMargin = "600px"): boolean {
	const [near, setNear] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (element === null || near) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setNear(true);
				observer.disconnect();
			}
		}, { rootMargin });
		observer.observe(element);
		return () => observer.disconnect();
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
	useEffect(() => () => {
		if (timer.current !== null) clearTimeout(timer.current);
	}, []);
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
			{tokens.map((token, index) =>
				token.type === null
					? (typeof token.content === "string" ? token.content : <HighlightedCode tokens={token.content} key={index} />)
					: (
						<span className={`token ${token.type}`} key={index}>
							{typeof token.content === "string" ? token.content : <HighlightedCode tokens={token.content} />}
						</span>
					)
			)}
		</>
	);
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
	const [tokens, setTokens] = useState<readonly HighlightToken[] | null>(null);
	const grammar = language.grammar;
	const wantsHighlight = settled && near && grammar !== null && code.length <= HIGHLIGHT_MAX_CHARS;
	useEffect(() => {
		if (!wantsHighlight || grammar === null) return;
		let cancelled = false;
		void highlightCode(code, grammar).then((result) => {
			if (!cancelled) setTokens(result);
		});
		return () => {
			cancelled = true;
		};
	}, [wantsHighlight, code, grammar]);
	const lineCount = code.length === 0 ? 0 : code.split("\n").length;
	return (
		<div
			className={`code-block${settled ? " is-settled" : " is-streaming"}`}
			ref={container}
			data-language={grammar ?? undefined}
		>
			<div className="code-block__bar">
				<span className="code-block__lang">{language.label ?? "text"}</span>
				<span className="code-block__lines">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
				<CopyButton text={code} />
			</div>
			<pre tabIndex={0}>
				<code className={grammar === null ? undefined : `language-${grammar}`}>
					{tokens === null ? code : <HighlightedCode tokens={tokens} />}
					{settled ? null : <span className="code-block__cursor" aria-hidden="true" />}
				</code>
			</pre>
		</div>
	);
});

interface MermaidBlockProps {
	readonly source: string;
	readonly settled: boolean;
}

export const MermaidBlock = memo(function MermaidBlock({ source, settled }: MermaidBlockProps) {
	const container = useRef<HTMLElement>(null);
	const near = useNearViewport(container);
	const [result, setResult] = useState<MermaidResult | null>(null);
	const [showSource, setShowSource] = useState(false);
	const problem = mermaidSourceProblem(source);
	const wantsRender = settled && near && problem === null;
	useEffect(() => {
		if (!wantsRender) return;
		let cancelled = false;
		setResult(null);
		void renderMermaid(source).then((rendered) => {
			if (!cancelled) setResult(rendered);
		});
		return () => {
			cancelled = true;
		};
	}, [wantsRender, source]);
	const state = !settled
		? "pending"
		: problem !== null
		? "bounded"
		: result === null
		? "rendering"
		: result.ok
		? "rendered"
		: "failed";
	const status = state === "pending"
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
		<figure className={`diagram is-${state}`} ref={container} aria-label="Mermaid diagram">
			<div className="code-block__bar">
				<span className="code-block__lang">mermaid</span>
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
				// Strict Mermaid output, sanitized by DOMPurify in mermaid.ts. Nothing else in the renderer sets innerHTML.
				<div className="diagram__canvas" dangerouslySetInnerHTML={{ __html: result.svg }} />
			)}
			{sourceVisible && (
				<pre tabIndex={0}>
					<code className="language-mermaid">{source}</code>
				</pre>
			)}
			{status !== null && (
				<figcaption className="diagram__status" role={state === "failed" ? "alert" : "status"}>{status}</figcaption>
			)}
		</figure>
	);
});

function headingTag(depth: number): "h2" | "h3" | "h4" | "h5" | "h6" {
	const level = Math.min(6, Math.max(2, depth + 1));
	return `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
}

function Inline({ tokens }: { tokens: readonly MarkdownToken[] }) {
	return <>{tokens.map((token, index) => <InlineToken token={token} key={index} />)}</>;
}

function InlineToken({ token }: { token: MarkdownToken }): ReactNode {
	switch (token.type) {
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
				<a
					className="md-link"
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					title={link.title ?? undefined}
				>
					<Inline tokens={link.tokens} />
				</a>
			);
		}
		case "image": {
			const image = token as Tokens.Image;
			return (
				<span className="md-image" title="Images are not fetched by the Clio Coder GUI">
					[image{image.text.length > 0 ? `: ${image.text}` : ""}]
				</span>
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
				<li className={item.task ? "md-task-item" : undefined} key={index}>
					<Blocks tokens={item.tokens} settled={settled} />
				</li>
			))}
		</>
	);
}

function Block({ token, settled }: { token: MarkdownToken; settled: boolean }): ReactNode {
	switch (token.type) {
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
			return text.tokens !== undefined && text.tokens.length > 0
				? <Inline tokens={text.tokens} />
				: decodeEntities(text.text);
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
		case "table": {
			const table = token as Tokens.Table;
			return (
				<div className="md-table">
					<table>
						<thead>
							<tr>
								{table.header.map((cell, index) => (
									<th scope="col" style={cell.align ? { textAlign: cell.align } : undefined} key={index}>
										<Inline tokens={cell.tokens} />
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{table.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, index) => (
										<td style={cell.align ? { textAlign: cell.align } : undefined} key={index}>
											<Inline tokens={cell.tokens} />
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
		case "hr":
			return <hr />;
		case "html":
			return <p className="md-html">{(token as Tokens.HTML).text}</p>;
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
}

export const Blocks = memo(
	function Blocks({ tokens, settled }: { tokens: readonly MarkdownToken[]; settled: boolean }) {
		return <>{tokens.map((token, index) => <Block token={token} settled={settled} key={index} />)}</>;
	},
);

interface MarkdownContentProps {
	readonly source: string;
	/** True once the narrative can no longer grow; the whole source is then lexed once, canonically. */
	readonly complete: boolean;
}

/**
 * One narrative. While streaming, settled blocks keep their token identity and
 * only the tail after the last block boundary is re-lexed each frame.
 */
export const MarkdownContent = memo(function MarkdownContent({ source, complete }: MarkdownContentProps) {
	const incremental = useRef<IncrementalMarkdown | null>(null);
	const split = useMemo(() => {
		if (complete) return null;
		incremental.current ??= new IncrementalMarkdown();
		return incremental.current.update(source);
	}, [source, complete]);
	const finalTokens = useMemo(() => complete ? lexMarkdown(source) : null, [source, complete]);
	if (finalTokens !== null) {
		return (
			<div className="markdown is-complete">
				<Blocks tokens={finalTokens} settled />
			</div>
		);
	}
	return (
		<div className="markdown is-streaming">
			<Blocks tokens={split?.settled ?? []} settled />
			<Blocks tokens={split?.tail ?? []} settled={false} />
		</div>
	);
});
