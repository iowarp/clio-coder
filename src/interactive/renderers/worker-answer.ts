import { sanitizeMultilineDisplayText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { GLYPH } from "../theme/index.js";

/** Sanitize complete source text before splitting, so OSC payloads cannot cross rows. */
export function safeWorkerAnswerText(text: string): string {
	const normalized = text
		.replaceAll(String.fromCharCode(0x9d), "\u001b]")
		.replaceAll(String.fromCharCode(0x9b), "\u001b[")
		.replaceAll(String.fromCharCode(0x9c), "\u001b\\");
	return redactSecretString(sanitizeMultilineDisplayText(normalized).text).replace(/[\p{Cf}\u0080-\u009f]/gu, "");
}

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

function reportString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface PresentedContractAnswer {
	lines: string[];
	footer?: string;
}

function debuggerReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	const diagnosis = reportString(value.diagnosis);
	const reproduction = value.reproduction;
	if (
		diagnosis === null ||
		(reproduction !== "reproduced" && reproduction !== "not-reproduced" && reproduction !== "unknown") ||
		!isStringArray(value.evidence)
	) {
		return null;
	}
	return {
		lines: [
			diagnosis,
			...(value.evidence.length === 0 ? ["Evidence: none"] : ["Evidence:", ...value.evidence.map((item) => `- ${item}`)]),
		],
		footer: `reproduction ${reproduction}`,
	};
}

function verifierReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if ((value.verdict !== "pass" && value.verdict !== "fail") || !Array.isArray(value.checks)) return null;
	const lines: string[] = [];
	for (const raw of value.checks) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const check = raw as Record<string, unknown>;
		const name = reportString(check.name);
		const evidence = reportString(check.evidence);
		if (name === null || evidence === null || typeof check.passed !== "boolean") return null;
		lines.push(`${check.passed ? GLYPH.ok : GLYPH.error} ${name}: ${evidence}`);
	}
	return { lines: lines.length === 0 ? ["No checks reported."] : lines, footer: `verdict ${value.verdict}` };
}

function researchReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if ((value.source !== "local" && value.source !== "external") || !Array.isArray(value.findings)) return null;
	const lines: string[] = [];
	for (const raw of value.findings) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const finding = raw as Record<string, unknown>;
		const claim = reportString(finding.claim);
		const evidence = reportString(finding.evidence);
		if (claim === null || evidence === null) return null;
		lines.push(`- ${claim}`, `  citation: ${evidence}`);
	}
	return { lines: lines.length === 0 ? ["No findings reported."] : lines, footer: `source ${value.source}` };
}

function worldKnowledgeReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if (
		(value.discovery !== "performed" &&
			value.discovery !== "caller-supplied-only" &&
			value.discovery !== "unavailable") ||
		!Array.isArray(value.facts) ||
		!isStringArray(value.synthesis) ||
		!isStringArray(value.uncertainties) ||
		!isStringArray(value.followUpVerification)
	) {
		return null;
	}
	const lines: string[] = [];
	for (const raw of value.facts) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const fact = raw as Record<string, unknown>;
		const claim = reportString(fact.claim);
		const evidence = reportString(fact.evidence);
		if (claim === null || evidence === null || !isStringArray(fact.sources)) return null;
		lines.push(`- ${claim}`, `  support: ${evidence}`);
		if (fact.sources.length > 0) lines.push(`  sources: ${fact.sources.join(", ")}`);
	}
	if (value.synthesis.length > 0) lines.push("Synthesis:", ...value.synthesis.map((item) => `- ${item}`));
	if (value.uncertainties.length > 0) lines.push("Uncertainties:", ...value.uncertainties.map((item) => `- ${item}`));
	if (value.followUpVerification.length > 0) {
		lines.push("Verify next:", ...value.followUpVerification.map((item) => `- ${item}`));
	}
	return {
		lines: lines.length === 0 ? ["No findings reported."] : lines,
		footer: `discovery ${value.discovery}; uncertainties ${value.uncertainties.length}; follow-up ${value.followUpVerification.length}`,
	};
}

function scoutReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if (!Array.isArray(value.findings) || typeof value.needsSplit !== "boolean") return null;
	const lines: string[] = [];
	for (const raw of value.findings) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const finding = raw as Record<string, unknown>;
		const claim = reportString(finding.claim);
		if (claim === null) return null;
		const path = reportString(finding.path);
		const line = typeof finding.line === "number" && Number.isSafeInteger(finding.line) ? finding.line : null;
		lines.push(path !== null && line !== null ? `- ${claim} — ${path}:${line}` : `- ${claim} (ungrounded lead)`);
	}
	if (value.needsSplit) {
		if (!Array.isArray(value.proposedSubtasks)) return null;
		lines.push("Split recommended:");
		for (const raw of value.proposedSubtasks) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
			const subtask = raw as Record<string, unknown>;
			const task = reportString(subtask.task);
			const id = reportString(subtask.id);
			if (task === null || id === null) return null;
			lines.push(`- ${id}: ${task}`);
		}
	}
	return {
		lines: lines.length === 0 ? ["No findings reported."] : lines,
		footer: value.needsSplit ? "split needed" : "no split needed",
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only a whole object, optionally enclosed by one whole code fence, is a preview payload. */
export function exactWorkerAnswerObject(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	const fenced = /^```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
	const source = fenced?.[1] ?? trimmed;
	try {
		const value: unknown = JSON.parse(source);
		return isObject(value) ? value : null;
	} catch {
		return null;
	}
}

/** Receipt identity and conformance are facts supplied by the caller, never inferred here. */
export function presentWorkerContractAnswer(
	text: string,
	contract: { kind: string; conformance: string } | undefined,
	complete: boolean,
	settled: boolean,
): PresentedContractAnswer | null {
	if (!settled || !complete || contract?.conformance !== "pass") return null;
	const value = exactWorkerAnswerObject(text);
	if (value === null) return null;
	// Match complete JSON strings before numbers, so escaped property names
	// and digits inside strings cannot bypass or confuse the token check.
	// Conservatively keep raw Scout source if any number cannot round-trip.
	if (contract.kind === "scout-report") {
		for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)) {
			const token = match[0];
			if (token.startsWith('"')) continue;
			if (!Number.isSafeInteger(Number(token)) || String(Number(token)) !== token) return null;
		}
	}
	let answer: PresentedContractAnswer | null;
	switch (contract.kind) {
		case "debugger-report":
			answer = debuggerReport(value);
			break;
		case "verifier-report":
			answer = verifierReport(value);
			break;
		case "research-report":
			answer = researchReport(value);
			break;
		case "world-knowledge-report":
			answer = worldKnowledgeReport(value);
			break;
		case "scout-report":
			answer = scoutReport(value);
			break;
		default:
			return null;
	}
	if (answer === null) return null;
	return {
		lines: answer.lines.map(safeWorkerAnswerText),
		...(answer.footer ? { footer: safeWorkerAnswerText(answer.footer) } : {}),
	};
}
