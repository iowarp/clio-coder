import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { registerExactBound } from "./profiles.js";
import type { Question } from "./types.js";

/**
 * Julia-1's own tokenizer, so its 48-token option contract is checked by count.
 * The byte proof refused nearly every site option (46 bytes stands for 48
 * tokens), so `toolCall` and `turnEnd` never reached Julia. The file is 34 MB,
 * too large to ship, so a bound `julia-1` engine fetches it once from the
 * published repository, pinned by revision and content hash, and caches it.
 * Until then, or offline, the byte proof still applies.
 */
const REVISION = "a85b127321d580d65176c89ced8273f305745d85";
const SHA256 = "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f";
const SOURCE = `https://huggingface.co/SupersonicLabs/Julia-1/resolve/${REVISION}/tokenizer/tokenizer.json`;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SPACE = "▁";

/** Julia's encoder: the strict contract in its `julia/data.py` `sequence()`. */
const OPTION_TOKENS = 48;
const HEAD_TOKENS = 512;
/** `sequence()` shortens options once the head budget falls under 16, which a strict request refuses. */
const MIN_HEAD_BUDGET = 16;

interface TokenizerFile {
	added_tokens?: ReadonlyArray<{ content: string }>;
	model: { type: string; vocab: Record<string, number>; merges: ReadonlyArray<string | [string, string]> };
}

export function juliaTokenizerPath(): string {
	return join(resolveClioDirs().cache, "system-one", `julia-1-${REVISION.slice(0, 12)}`, "tokenizer.json");
}

let loading: Promise<boolean> | null = null;

/** Fetches, verifies and registers the counter once per process; false leaves the byte proof in place. */
export function loadJuliaTokenizer(): Promise<boolean> {
	loading ??= (async () => {
		const path = juliaTokenizerPath();
		let bytes: Buffer | null = existsSync(path) ? readFileSync(path) : null;
		if (bytes === null || sha256(bytes) !== SHA256) {
			const response = await fetch(SOURCE, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
			if (!response.ok) throw new Error(`Julia-1 tokenizer download failed: HTTP ${response.status}`);
			bytes = Buffer.from(await response.arrayBuffer());
			if (sha256(bytes) !== SHA256) throw new Error("Julia-1 tokenizer download does not match its pinned hash");
			safeResourceWrite(path, bytes);
		}
		const count = createBpeCounter(JSON.parse(bytes.toString("utf8")) as TokenizerFile);
		registerExactBound("julia-1", (question, options) => juliaBound(question, options, count));
		return true;
	})().catch(() => {
		// Offline or blocked: the byte proof stays, which only abstains more often.
		loading = null;
		return false;
	});
	return loading;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function juliaBound(question: Question, options: ReadonlyArray<string>, count: TokenCount): string | null {
	const lengths: number[] = [];
	for (const [index, text] of options.entries()) {
		const tokens = count(` ${text}`);
		if (tokens > OPTION_TOKENS) return `option ${index} is ${tokens} tokens; Julia-1 reads ${OPTION_TOKENS}`;
		lengths.push(tokens);
	}
	const head = count(`${question.type} question: ${question.instructions}`);
	// Each option also carries its marker token.
	const budget = HEAD_TOKENS - lengths.reduce((sum, length) => sum + length + 1, 0);
	if (budget < MIN_HEAD_BUDGET || head > budget) {
		return `question head and options need ${HEAD_TOKENS - budget + head} tokens; Julia-1 reads ${HEAD_TOKENS}`;
	}
	return null;
}

type TokenCount = (text: string) => number;

/**
 * Token count for the `tokenizers` BPE pipeline this file declares. Added
 * tokens (newlines, tab runs, markers) are matched first, longest at each
 * position, and count one each. Every other segment has its spaces turned into
 * U+2581, a leading one prepended, words split before each U+2581, and each
 * word merged by rank with byte fallback. Only single-character vocabulary and
 * merge ranks are kept, so the parsed file can be collected.
 */
export function createBpeCounter(file: TokenizerFile): TokenCount {
	if (file.model.type !== "BPE") throw new Error(`unsupported tokenizer model ${file.model.type}`);
	const chars = new Set(Object.keys(file.model.vocab).filter((piece) => [...piece].length === 1));
	const ranks = new Map<string, number>();
	for (const [rank, merge] of file.model.merges.entries()) {
		const [left, right] = typeof merge === "string" ? merge.split(" ") : merge;
		ranks.set(`${left}\u0000${right}`, rank);
	}
	const added = (file.added_tokens ?? [])
		.map((token) => token.content)
		.filter((content) => content.length > 0)
		.sort((left, right) => right.length - left.length)
		.map((content) => content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const addedPattern = added.length > 0 ? new RegExp(added.join("|"), "gu") : null;
	const countWord = (word: string): number => {
		const symbols: string[] = [];
		for (const char of word) {
			if (chars.has(char)) symbols.push(char);
			else
				for (const byte of Buffer.from(char, "utf8"))
					symbols.push(`<0x${byte.toString(16).toUpperCase().padStart(2, "0")}>`);
		}
		for (;;) {
			let best = -1;
			let bestRank = Number.POSITIVE_INFINITY;
			for (let index = 0; index < symbols.length - 1; index += 1) {
				const rank = ranks.get(`${symbols[index]}\u0000${symbols[index + 1]}`);
				if (rank !== undefined && rank < bestRank) {
					bestRank = rank;
					best = index;
				}
			}
			if (best < 0) return symbols.length;
			symbols.splice(best, 2, `${symbols[best]}${symbols[best + 1]}`);
		}
	};
	const countSegment = (segment: string): number => {
		if (segment.length === 0) return 0;
		let normalized = segment.replaceAll(" ", SPACE);
		if (!normalized.startsWith(SPACE)) normalized = `${SPACE}${normalized}`;
		return normalized
			.split(new RegExp(`(?=${SPACE})`, "u"))
			.filter((word) => word.length > 0)
			.reduce((sum, word) => sum + countWord(word), 0);
	};
	return (text) => {
		if (addedPattern === null) return countSegment(text);
		let total = 0;
		let last = 0;
		for (const match of text.matchAll(addedPattern)) {
			total += countSegment(text.slice(last, match.index)) + 1;
			last = match.index + match[0].length;
		}
		return total + countSegment(text.slice(last));
	};
}
