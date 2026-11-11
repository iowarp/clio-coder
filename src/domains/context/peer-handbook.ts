/**
 * The handbook compiled for a delegated peer: another harness (Claude Code,
 * Codex, opencode, Pi) running a task as a subprocess worker. The peer also
 * reads its own instruction file from the repository, so the compile gives it
 * one rule set to follow: the rules a native worker of the same recipe would
 * get, minus those that only make sense inside Clio, plus the peer file's own
 * rules that still hold. A rule of that file the tree no longer supports is
 * simply absent, and where the tree states the right value that value is an
 * ordinary rule with its evidence. Nothing here names the peer's file or argues
 * with it: text that tells a model to disregard its instructions reads as
 * prompt injection to the harness receiving it.
 *
 * Pure and deterministic: the same inputs render the same bytes.
 */
import type { HandbookLedgerEntry } from "./bootstrap.js";
import { normalizeHandbookRule } from "./handbook-budget.js";
import { type CompiledHandbook, type HandbookAudience, selectWorkerHandbook } from "./handbook-units.js";
import { contradictingFact, type TreeFact } from "./tree-facts.js";

export type PeerRuleVerdict = Pick<HandbookLedgerEntry, "text" | "citations" | "verdict" | "source">;

export interface PeerHandbookOptions {
	audience: ReadonlyArray<HandbookAudience>;
	cwd: string;
	workingPaths: ReadonlyArray<string>;
	maxChars: number;
	/** The judged units of the peer's own instruction files, in file order. */
	peerRules: ReadonlyArray<PeerRuleVerdict>;
	facts: ReadonlyArray<TreeFact>;
	/** Clio tool, skill and recipe names: a handbook rule citing one only makes sense inside Clio. */
	clioNames: ReadonlyArray<string>;
}

export interface PeerHandbook {
	text: string;
	/** Rules of the peer's files the compile carries, in its own block or as the handbook's identical rule. */
	carried: number;
	/** Rules of the peer's files the tree no longer supports; never emitted. */
	stale: number;
	/** Tree facts emitted as rules where a stale rule stated the value. */
	facts: number;
	/** Rules for this run, of the handbook or the peer's files, that hold but did not fit the bound. */
	notCarried: number;
}

/** The share of the bound the peer's own rules may claim; the handbook, invariants first, keeps the rest. */
const PEER_RULES_SHARE = 0.4;

const CODE_TOKEN_RE = /`([^`\n]+)`/g;
const SCRIPT_CALL_RE = /^(pnpm|npm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9_:.-]+)$/;

function citesClio(text: string, names: ReadonlySet<string>): boolean {
	for (const match of text.matchAll(CODE_TOKEN_RE)) {
		const token = (match[1] ?? "").trim().replace(/\(\)$/, "");
		if (names.has(token)) return true;
	}
	return false;
}

/** `package.json scripts.test` as `` `package.json` `scripts.test` ``; a bare `CI` stays prose. */
function evidence(source: string): string {
	return source
		.split(" ")
		.map((part) => (part === "CI" ? part : `\`${part}\``))
		.join(" ");
}

function factRule(fact: TreeFact): string | undefined {
	const from = evidence(fact.source);
	switch (fact.key) {
		case "package-manager":
			return `The package manager is \`${fact.value}\`, from ${from}.`;
		case "test-runner":
			return `Tests run with \`${fact.value}\`, from ${from}.`;
		case "formatter":
			return `The formatter is \`${fact.value}\`, from ${from}.`;
		case "ts-strict":
			return `TypeScript strict mode is ${fact.value === "true" ? "on" : "off"}, from ${from}.`;
		case "node-engine":
			return `The supported Node version is \`${fact.value}\`, from ${from}.`;
		default:
			return undefined;
	}
}

/**
 * The tree's own value for what a stale rule stated: the fact it contradicts,
 * or for a package script the tree lacks (`pnpm run test:all`), the script it
 * extends (`test`) as this repository runs it.
 */
function replacementRule(rule: PeerRuleVerdict, facts: ReadonlyArray<TreeFact>): string | undefined {
	if (rule.verdict === "contradicted") {
		const fact = contradictingFact(rule.text, facts);
		return fact ? factRule(fact) : undefined;
	}
	const scripts = new Set(
		(facts.find((fact) => fact.key === "scripts")?.value ?? "").split(", ").filter((name) => name.length > 0),
	);
	const manager = facts.find((fact) => fact.key === "package-manager")?.value;
	for (const citation of rule.citations) {
		const call = SCRIPT_CALL_RE.exec(citation.trim());
		if (!call || scripts.has(call[2] ?? "")) continue;
		const base = (call[2] ?? "").split(":")[0] ?? "";
		if (!scripts.has(base)) continue;
		return `The ${base} command is \`${manager ?? call[1]} run ${base}\`, from \`package.json\` \`scripts.${base}\`.`;
	}
	return undefined;
}

function renderBlock(lines: ReadonlyArray<string>): string {
	return lines.length === 0
		? ""
		: ["<project-rules>", ...lines.map((line) => `- ${line}`), "</project-rules>"].join("\n");
}

export function compilePeerHandbook(
	handbooks: ReadonlyArray<CompiledHandbook>,
	options: PeerHandbookOptions,
): PeerHandbook {
	const clioNames = new Set(options.clioNames);
	const portable = handbooks
		.map((handbook) => ({
			...handbook,
			units: handbook.units.filter((unit) => !unit.audience.includes("orchestrator") && !citesClio(unit.text, clioNames)),
		}))
		.filter((handbook) => handbook.units.length > 0);
	const handbookUnitByKey = new Map<string, string>();
	for (const handbook of portable) {
		for (const unit of handbook.units) {
			const key = normalizeHandbookRule(unit.text);
			if (!handbookUnitByKey.has(key)) handbookUnitByKey.set(key, unit.id);
		}
	}

	const seen = new Set<string>();
	const verified: string[] = [];
	const unverifiable: string[] = [];
	const duplicates: Array<{ text: string; unitId: string }> = [];
	const replacements: string[] = [];
	let stale = 0;
	for (const rule of options.peerRules) {
		if (rule.verdict === "stale" || rule.verdict === "contradicted") {
			stale += 1;
			const replacement = replacementRule(rule, options.facts);
			if (replacement !== undefined && !replacements.includes(replacement)) replacements.push(replacement);
			continue;
		}
		const key = normalizeHandbookRule(rule.text);
		if (seen.has(key)) continue;
		seen.add(key);
		const unitId = handbookUnitByKey.get(key);
		if (unitId !== undefined) duplicates.push({ text: rule.text, unitId });
		else (rule.verdict === "verified" ? verified : unverifiable).push(rule.text);
	}

	// The handbook keeps its room first, invariants leading, less a reserve for the peer's own rules; those then
	// take whatever room the selection left.
	const own = [...verified, ...replacements, ...unverifiable];
	const reserved =
		own.length > 0 ? Math.min(Math.floor(PEER_RULES_SHARE * options.maxChars), renderBlock(own).length + 2) : 0;
	const selection = selectWorkerHandbook(portable, {
		audience: options.audience.filter((entry) => entry !== "orchestrator"),
		cwd: options.cwd,
		workingPaths: options.workingPaths,
		maxChars: Math.max(0, options.maxChars - reserved),
	});
	const join = (block: string): string => [selection.text, block].filter((part) => part.length > 0).join("\n\n");
	let kept = own.length;
	while (kept > 0 && join(renderBlock(own.slice(0, kept))).length > options.maxChars) kept -= 1;
	const lines = own.slice(0, kept);
	const ownCarried = lines.filter((line) => !replacements.includes(line)).length;
	let notCarried = verified.length + unverifiable.length - ownCarried;
	// A rule the handbook also states rides once: in the handbook when selected, else in the peer's block if it fits.
	let carriedDuplicates = 0;
	for (const duplicate of duplicates) {
		if (selection.unitIds.includes(duplicate.unitId)) {
			carriedDuplicates += 1;
			continue;
		}
		if (join(renderBlock([...lines, duplicate.text])).length <= options.maxChars) {
			lines.push(duplicate.text);
			carriedDuplicates += 1;
		} else notCarried += 1;
	}
	// A dropped handbook rule the peer's files also state was settled above, carried or counted.
	const duplicateUnitIds = new Set(duplicates.map((duplicate) => duplicate.unitId));
	notCarried += new Set(selection.droppedIds.filter((id) => !duplicateUnitIds.has(id))).size;
	return {
		text: join(renderBlock(lines)),
		carried: ownCarried + carriedDuplicates,
		stale,
		facts: lines.filter((line) => replacements.includes(line)).length,
		notCarried,
	};
}
