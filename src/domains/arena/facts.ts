import type { FactSum } from "../../core/telemetry/fact.js";
import type { PricingSum } from "../../core/telemetry/pricing.js";
import type { ArenaDiffStat } from "./types.js";

/** What one contender's `run --json-events full` stream says, read frame by frame. */
export interface ArenaStreamFacts {
	sessionId: string | null;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	writes: number;
	blocks: number;
	totalTokens: FactSum | null;
	cost: PricingSum | null;
	finalText: string;
}

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFactSum(value: unknown): value is FactSum {
	return (
		isRecord(value) &&
		typeof value.measured === "number" &&
		typeof value.estimated === "number" &&
		typeof value.unknownCount === "number" &&
		typeof value.absentCount === "number" &&
		isRecord(value.coverage)
	);
}

function addFactSums(a: FactSum | null, b: FactSum): FactSum {
	if (a === null) return { ...b, coverage: { ...b.coverage } };
	return {
		measured: a.measured + b.measured,
		estimated: a.estimated + b.estimated,
		unknownCount: a.unknownCount + b.unknownCount,
		absentCount: a.absentCount + b.absentCount,
		coverage: {
			measured: a.coverage.measured + b.coverage.measured,
			estimated: a.coverage.estimated + b.coverage.estimated,
			unknown: a.coverage.unknown + b.coverage.unknown,
		},
	};
}

function readPricingSum(value: unknown): PricingSum | null {
	if (!isRecord(value) || !isFactSum(value.usd) || typeof value.free !== "boolean") return null;
	return { usd: value.usd, free: value.free };
}

function addPricingSums(a: PricingSum | null, b: PricingSum): PricingSum {
	if (a === null) return b;
	return { usd: addFactSums(a.usd, b.usd), free: a.free && b.free };
}

function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is Frame => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.trim();
}

/**
 * Count what the stream reports. A write is a tool the policy classed as a
 * write that finished ok; a block is any refusal by policy or by the operator.
 * Token and cost sums stay FactSums, so an unpriced route reads as not
 * measured downstream, never as zero. A headless turn may span several agent
 * segments, each closing with its own `agent_end`, so their usage adds up.
 */
export function readArenaStream(ndjson: string): ArenaStreamFacts {
	const facts: ArenaStreamFacts = {
		sessionId: null,
		turns: 0,
		toolCalls: 0,
		toolErrors: 0,
		writes: 0,
		blocks: 0,
		totalTokens: null,
		cost: null,
		finalText: "",
	};
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let frame: unknown;
		try {
			frame = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(frame)) continue;
		switch (frame.type) {
			case "session":
				if (typeof frame.id === "string") facts.sessionId = frame.id;
				break;
			case "turn_end": {
				facts.turns += 1;
				const text = typeof frame.text === "string" ? frame.text.trim() : assistantText(frame.message);
				if (text.length > 0) facts.finalText = text;
				break;
			}
			case "tool_execution_end": {
				facts.toolCalls += 1;
				const blocked = frame.decision === "blocked" || frame.decision === "denied" || frame.outcome === "blocked";
				if (blocked) facts.blocks += 1;
				else if (frame.isError === true || frame.outcome === "error") facts.toolErrors += 1;
				else if (frame.actionClass === "write" && frame.outcome === "ok") facts.writes += 1;
				break;
			}
			case "agent_end": {
				const usage = frame.usage;
				if (!isRecord(usage)) break;
				if (isFactSum(usage.totalTokens)) facts.totalTokens = addFactSums(facts.totalTokens, usage.totalTokens);
				const cost = readPricingSum(usage.cost);
				if (cost !== null) facts.cost = addPricingSums(facts.cost, cost);
				break;
			}
		}
	}
	return facts;
}

/**
 * The writes a contender made. The stream counts the calls the policy classed
 * as writes, but an extension tool runs as execute (a package may hold read
 * and write tools under one fs.write grant) and a shell edit does too, so a
 * contender whose only change came through one of those read as no writes
 * beside a non-empty diff. A file in the saved diff was written at least once.
 */
export function contenderWrites(streamWrites: number, diff: ArenaDiffStat | null): number {
	return Math.max(streamWrites, diff?.files ?? 0);
}

/** Read `git diff --numstat` output; a binary file counts as a file with no line counts. */
export function readNumstat(numstat: string): ArenaDiffStat {
	const stat: ArenaDiffStat = { files: 0, insertions: 0, deletions: 0 };
	for (const line of numstat.split("\n")) {
		const [added, removed] = line.split("\t");
		if (added === undefined || removed === undefined) continue;
		stat.files += 1;
		stat.insertions += Number.parseInt(added, 10) || 0;
		stat.deletions += Number.parseInt(removed, 10) || 0;
	}
	return stat;
}
