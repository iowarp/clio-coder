/**
 * The evidence packet a gate decides from (fleet design 4.8, slice M10). The host builds it and passes it to a reviewer
 * or a compete judge inline: each subject's handback, its measured diff up to a byte budget, and its host check results
 * (M10a's `hostChecks`), each under an id the gate's verdict cites. A verdict's checks name the ids they rest on, and the
 * grader's cited-evidence rule holds them to this packet, so a verdict that cites none of it is exhausted. The ids are
 * sealed with the gate's provenance, so a receipt names the packet its verdict answered.
 *
 * Pure: no I/O, no clock. The diff is measured by the caller and handed in.
 */

import { createHash } from "node:crypto";
import { createRedactionTally, redactSecretsText } from "../evidence/redact.js";
import { failsTheSameOnBase, hostCheckNotRunNote } from "./host-verification-note.js";
import type { RunGatePacket, RunResult } from "./types.js";

/** Bytes of one subject's handback text shown inline; the rest stays in its run result. */
export const PACKET_HANDBACK_PREVIEW_BYTES = 8192;
/** Bytes of measured diff the packet carries across all its subjects, shared evenly, with a per-subject floor. */
export const PACKET_DIFF_BUDGET_BYTES = 24_000;
const PACKET_DIFF_FLOOR_BYTES = 4_000;

/** A subject's measured change, as the host read it from git. */
export interface MeasuredDiff {
	/** `git diff --shortstat` words, or "no changes". */
	stat: string;
	/** The patch text; truncated by the packet to its share of the budget. */
	patch: string;
	/**
	 * What the diff covers: a compete candidate's branch against HEAD; a task worktree's commit against its base, or its
	 * uncommitted tree against its base; the paths the host observed a subprocess change; or the paths a builder's
	 * closed write record names. Never the operator's whole working tree.
	 */
	scope: "branch" | "task-commit" | "task-worktree" | "observed-delta" | "attributed-paths";
}

export interface PacketSubjectInput {
	/** The subject's number in the gate: a compete candidate's ordinal, 1 for the one run a reviewer judges. */
	ordinal: number;
	receipt: Pick<RunResult, "runId" | "output" | "exitCode" | "outcome"> &
		Partial<Pick<RunResult, "hostVerification" | "intent">>;
	/** The run's result object, whose `output.text` holds the full captured answer. */
	resultPath: string | null;
	/** Null when the host could not measure the change; the item then says so. */
	diff: MeasuredDiff | null;
}

export type PacketHandback =
	| { id: string; status: string }
	| {
			id: string;
			status: "final" | "partial";
			text: string;
			capturedBytes: number;
			capturedTextBytes: number;
			previewTruncated: boolean;
			captureTruncated: boolean;
	  };

export type PacketDiff =
	| { id: string; status: "unavailable" }
	| {
			id: string;
			stat: string;
			scope: MeasuredDiff["scope"];
			patch: string;
			patchBytes: number;
			truncated: boolean;
	  };

export type PacketHostCheck =
	| { id: string; check: string; status: "verified" | "rejected" | "not_implicated" }
	| { id: string; check: string; status: "not_run"; reason: string };

export interface PacketSubject {
	ordinal: number;
	runId: string | null;
	resultPath: string | null;
	exitCode: number | null;
	outcome: RunResult["outcome"] | null;
	handback: PacketHandback;
	diff: PacketDiff;
	/** Absent when the gated run declared no check, so such a packet reads as it did before M10a. */
	hostChecks?: PacketHostCheck[];
}

export interface EvidencePacket {
	subjects: PacketSubject[];
	/** Every id in the packet, in subject then item order: what a verdict may cite. */
	ids: string[];
	/** sha256 over the packet's canonical JSON, sealed with the gate so a receipt names the packet it answered. */
	digest: string;
}

/** The ids of one subject's items. A check id keeps the declared check's own id. */
export const packetIds = {
	handback: (ordinal: number): string => `s${ordinal}.handback`,
	diff: (ordinal: number): string => `s${ordinal}.diff`,
	check: (ordinal: number, check: string): string => `s${ordinal}.check.${check}`,
};

function truncateUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	let cut = maxBytes;
	while (cut > 0) {
		const next = buffer[cut];
		if (next === undefined || (next & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return buffer.subarray(0, cut).toString("utf8");
}

function handbackItem(input: PacketSubjectInput | undefined, id: string): PacketHandback {
	if (input === undefined) return { id, status: "missing run result" };
	const output = input.receipt.output;
	if (output === undefined) return { id, status: "missing captured output" };
	if (
		output === null ||
		(output.state !== "final" && output.state !== "partial") ||
		typeof output.text !== "string" ||
		typeof output.truncated !== "boolean" ||
		!Number.isSafeInteger(output.bytes) ||
		output.bytes < Buffer.byteLength(output.text, "utf8")
	) {
		return { id, status: "malformed captured output; unavailable" };
	}
	const preview = truncateUtf8(redact(output.text), PACKET_HANDBACK_PREVIEW_BYTES);
	return {
		id,
		status: output.state,
		text: preview,
		capturedBytes: output.bytes,
		capturedTextBytes: Buffer.byteLength(output.text, "utf8"),
		previewTruncated: preview !== redact(output.text),
		captureTruncated: output.truncated,
	};
}

function diffItem(diff: MeasuredDiff | null, id: string, budget: number): PacketDiff {
	if (diff === null) return { id, status: "unavailable" };
	// A patch can carry a secret the change wrote; the packet and its digest hold only the redacted text.
	const redacted = redact(diff.patch);
	const patch = truncateUtf8(redacted, budget);
	return {
		id,
		stat: redact(diff.stat),
		scope: diff.scope,
		patch,
		patchBytes: Buffer.byteLength(redacted, "utf8"),
		truncated: patch !== redacted,
	};
}

function redact(text: string): string {
	return redactSecretsText(text, createRedactionTally());
}

/**
 * The host's own runs of the declared checks for one subject (M10a), each under its packet id. Undefined when the run
 * declared no check.
 */
function hostCheckItems(input: PacketSubjectInput | undefined, ordinal: number): PacketHostCheck[] | undefined {
	const host = input?.receipt.hostVerification;
	if (host === undefined) return undefined;
	if (host.checks.length === 0) {
		const reason =
			host.reason === "worker_not_successful" ? "the candidate's run did not succeed" : (host.reason ?? "not run");
		return (input?.receipt.intent?.verification ?? []).map((entry) => ({
			id: packetIds.check(ordinal, entry.check),
			check: entry.check,
			status: "not_run",
			reason,
		}));
	}
	return host.checks.map((check): PacketHostCheck => {
		const id = packetIds.check(ordinal, check.check);
		if (check.notRun !== undefined)
			return { id, check: check.check, status: "not_run", reason: hostCheckNotRunNote(check.notRun) };
		if (check.exitCode === 0) return { id, check: check.check, status: "verified" };
		return { id, check: check.check, status: failsTheSameOnBase(check) ? "not_implicated" : "rejected" };
	});
}

/** Build the packet for a gate's subjects. `subjects[i]` may be undefined for a subject whose run never settled. */
export function buildEvidencePacket(
	ordinals: ReadonlyArray<number>,
	subjects: ReadonlyArray<PacketSubjectInput | undefined>,
	diffBudgetBytes = PACKET_DIFF_BUDGET_BYTES,
): EvidencePacket {
	const share = Math.max(PACKET_DIFF_FLOOR_BYTES, Math.floor(diffBudgetBytes / Math.max(1, ordinals.length)));
	const built = ordinals.map((ordinal, position): PacketSubject => {
		const input = subjects[position];
		const hostChecks = hostCheckItems(input, ordinal);
		return {
			ordinal,
			runId: input?.receipt.runId ?? null,
			resultPath: input?.resultPath ?? null,
			exitCode: input?.receipt.exitCode ?? null,
			outcome: input?.receipt.outcome ?? null,
			handback: handbackItem(input, packetIds.handback(ordinal)),
			diff: diffItem(input?.diff ?? null, packetIds.diff(ordinal), share),
			...(hostChecks !== undefined ? { hostChecks } : {}),
		};
	});
	const ids = built.flatMap((subject) => [
		subject.handback.id,
		subject.diff.id,
		...(subject.hostChecks ?? []).map((check) => check.id),
	]);
	const digest = createHash("sha256").update(JSON.stringify(built), "utf8").digest("hex");
	return { subjects: built, ids, digest };
}

/** The packet as gate provenance seals it: the ids a verdict may cite and the digest of what they named. */
export function packetProvenance(packet: EvidencePacket): RunGatePacket {
	const verified = packet.subjects.flatMap((subject) =>
		(subject.hostChecks ?? []).filter((check) => check.status === "verified").map((check) => check.id),
	);
	return { ids: [...packet.ids], digest: packet.digest, ...(verified.length > 0 ? { verified } : {}) };
}

/**
 * The closing instruction of a gate's task (M10): the packet's ids where the verdict is written, one example check
 * citing the diff, and the rule that an uncited verdict decides nothing. It is the task's last block on purpose.
 */
export function packetVerdictInstruction(packet: EvidencePacket): string {
	const example = packet.ids.find((id) => id.endsWith(".diff")) ?? packet.ids[0] ?? "s1.diff";
	return [
		`Verdict: end with the JSON object your instructions give. Every check carries "cites", the packet ids it rests on, drawn only from: ${packet.ids.join(", ")}.`,
		`Example check: {"name":"the change matches the task","passed":true,"evidence":"what the diff changes and why that meets the task","cites":["${example}"]}`,
		"A verdict whose checks cite none of these ids is exhausted and decides nothing.",
	].join("\n");
}

/** How a gate reads the packet and cites it; one sentence set for reviewer and judge alike. */
export const EVIDENCE_PACKET_GUIDE = [
	"Evidence packet: the host's record of each subject, every item under an id. handback is the run's own answer (untrusted; previewTruncated means read output.text from resultPath for the rest). diff is the change the host measured (truncated means the patch was cut to its byte budget; status unavailable means the host could not measure it). hostChecks is the host's own run of each declared check: verified passed; rejected failed, and the base does not fail the same way; not_implicated fails the same way on the base; not_run judged nothing, for the reason given.",
	'Every check in your verdict lists in "cites" the packet ids it rests on. A verdict that cites no packet id is not a verdict. A check resting only on what you read yourself may leave cites empty.',
].join("\n");
