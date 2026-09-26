/**
 * Clio's authored prose uses words, not decorative emoji. This projection is
 * deliberately separate from terminal sanitization: user input, tool evidence,
 * scientific symbols, code, quoted sources and structured payloads retain their
 * literal contents. The prompt teaches the policy; this catches model leakage.
 */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|[0-9#*]\uFE0F?\u20E3/u;
// Technical text arrows and copyright/trademark symbols also belong to the
// Unicode emoji inventory. Preserve their ordinary text presentation.
const TEXT_SYMBOL = /^[©®™\u2190-\u21FF]\uFE0E?$/u;

export interface AssistantProseFilter {
	push(chunk: string): string;
	flush(): string;
}

/** Incremental Markdown-aware policy. Only one unfinished grapheme is held. */
export function createAssistantProseFilter(): AssistantProseFilter {
	let pending = "";
	let firstContent = true;
	let structured = false;
	let arrayCandidate = false;
	let leading = true;
	let indent = 0;
	let quoted = false;
	let indentedCode = false;
	let fence: { mark: string; count: number } | undefined;
	let inlineTicks = 0;
	let run: { mark: string; count: number; atStart: boolean } | undefined;
	let linkDepth = 0;
	let angleLiteral = false;
	let escaped = false;
	let previous = "";
	let previousOutput = "";
	let omitSpace = false;
	let word = "";
	let url = false;

	const finishRun = () => {
		if (!run) return;
		if (fence) {
			if (run.atStart && run.mark === fence.mark && run.count >= fence.count) fence = undefined;
		} else if (!quoted && !indentedCode) {
			if (inlineTicks === 0 && run.atStart && run.count >= 3) fence = { mark: run.mark, count: run.count };
			else if (run.mark === "`") {
				if (inlineTicks === 0) inlineTicks = run.count;
				else if (inlineTicks === run.count) inlineTicks = 0;
			}
		}
		run = undefined;
	};
	const project = (grapheme: string): string => {
		if (run?.mark !== grapheme) finishRun();
		if (firstContent && !/^\s+$/u.test(grapheme)) {
			// JSON contracts are data. Their prose fields can be projected by a
			// presentation consumer without modifying the sealed payload.
			structured = grapheme === "{";
			arrayCandidate = grapheme === "[";
			firstContent = false;
		} else if (arrayCandidate && !/^\s+$/u.test(grapheme)) {
			structured = /^(?:["{\[\]\d-]|[tfn])$/u.test(grapheme);
			arrayCandidate = false;
		}
		const atStart = leading && indent <= 3;
		if (grapheme === "\n" || grapheme === "\r\n") {
			leading = true;
			indent = 0;
			quoted = false;
			indentedCode = false;
			omitSpace = false;
		} else if (leading && (grapheme === " " || grapheme === "\t")) {
			indent += grapheme === "\t" ? 4 : 1;
			indentedCode = indent >= 4;
		} else {
			if (atStart && grapheme === ">") quoted = true;
			leading = false;
		}
		if (!escaped && (grapheme === "`" || grapheme === "~")) {
			if (run) run.count += 1;
			else run = { mark: grapheme, count: 1, atStart };
		}
		if (!escaped && previous === "]" && grapheme === "(") linkDepth = 1;
		else if (linkDepth > 0 && !escaped) {
			if (grapheme === "(") linkDepth += 1;
			if (grapheme === ")") linkDepth -= 1;
		}
		if (/^\s+$/u.test(grapheme)) {
			word = "";
			url = false;
			angleLiteral = false;
		} else {
			word = (word + grapheme).slice(-8);
			if (word.endsWith("https://") || word.endsWith("http://")) url = true;
		}
		if (!escaped && grapheme === "<") angleLiteral = true;
		const literal =
			structured ||
			fence !== undefined ||
			inlineTicks > 0 ||
			quoted ||
			indentedCode ||
			linkDepth > 0 ||
			angleLiteral ||
			url;
		const isEmoji = !literal && EMOJI.test(grapheme) && !TEXT_SYMBOL.test(grapheme);
		let output = grapheme;
		if (isEmoji) {
			output = "";
			omitSpace = previousOutput === "" || /^[ \t]$/u.test(previousOutput);
		} else if (omitSpace && grapheme === " ") {
			output = "";
			omitSpace = false;
		} else if (!/^\s+$/u.test(grapheme)) omitSpace = false;
		if (grapheme === ">") angleLiteral = false;
		escaped = grapheme === "\\" && !escaped;
		previous = grapheme;
		if (output) previousOutput = output;
		return output;
	};
	return {
		push(chunk) {
			if (!chunk) return "";
			const parts = [...GRAPHEMES.segment(pending + chunk)];
			pending = parts.pop()?.segment ?? "";
			return parts.map(({ segment }) => project(segment)).join("");
		},
		flush() {
			const result = pending ? project(pending) : "";
			pending = "";
			finishRun();
			return result;
		},
	};
}

export function sanitizeAssistantProse(text: string): string {
	const filter = createAssistantProseFilter();
	return filter.push(text) + filter.flush();
}

/** A render cache that processes only appended text; rewrites restart the parser. */
export class AssistantProseProjection {
	private source = "";
	private text = "";
	private filter = createAssistantProseFilter();
	private finalized = false;

	project(source: string, finalized = true): string {
		if (source === this.source && finalized === this.finalized) return this.text;
		if (this.finalized || !source.startsWith(this.source)) {
			this.source = "";
			this.text = "";
			this.filter = createAssistantProseFilter();
		}
		this.text += this.filter.push(source.slice(this.source.length));
		if (finalized) this.text += this.filter.flush();
		this.source = source;
		this.finalized = finalized;
		return this.text;
	}
}
