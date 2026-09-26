// What a sealed run receipt says was checked, one independent fact per row. The receipt reaches the
// browser as untyped JSON, so every field is read defensively: a shape this build does not know reads
// as "not recorded", never as a pass. No row summarizes another, because verification, typed checks,
// host checks, result-contract conformance, contract quality and claim grounding are sealed by
// different authorities and a quiet pass on one says nothing about the rest.

import type { StatusTone } from "../../design/status.js";

export interface CheckItem {
	/** Position and name; two checks may share a name. */
	id: string;
	name: string;
	tone: StatusTone;
	word: string;
	/** Exact values such as an exit code, a duration or a validator digest, in display order. */
	facts: string[];
	/** The tail of a check's own output, shown only on request. */
	output?: string;
}

export interface CheckRow {
	key: "verification" | "typed" | "host" | "conformance" | "quality" | "schema" | "grounding";
	label: string;
	tone: StatusTone;
	word: string;
	/** One sentence saying what the state means for this run. */
	meaning: string;
	/** Who produced the fact, so a reader can weigh it. */
	source: string;
	/** Exact identity behind the fact, such as a contract and its validator digest. */
	exact?: string;
	items: CheckItem[];
}

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const string = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const count = (value: unknown): number | null =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const keyed = (items: Omit<CheckItem, "id">[]): CheckItem[] =>
	items.map((item, index) => ({ ...item, id: `${index}:${item.name}` }));

/** A validator digest is an exact identity, not prose; twelve characters tell two apart on screen. */
export function shortDigest(value: unknown): string | null {
	const text = string(value);
	return text ? `digest ${text.slice(0, 12)}` : null;
}

/** `agent-result-contract:scout-report:<digest>` names its contract kind in the middle segment. */
export function contractName(sourceId: unknown): string | null {
	const text = string(sourceId);
	if (!text) return null;
	const [prefix, kind] = text.split(":");
	return prefix === "agent-result-contract" && kind ? kind.replace(/-/g, " ") : text;
}

/** `tool:verify` is the verify tool; any other source id stays exact. */
function sourceName(sourceId: unknown): string {
	const text = string(sourceId);
	if (!text) return "Unnamed check";
	return text.startsWith("tool:") ? `${text.slice(5)} tool` : text;
}

const NOT_RECORDED = (key: CheckRow["key"], label: string, source: string, meaning: string): CheckRow => ({
	key,
	label,
	tone: "unverified",
	word: "Not recorded",
	meaning,
	source,
	items: [],
});

const VERIFICATION_SOURCE = "Sealed by Clio Coder from the run's own tool calls.";

function verification(receipt: Record<string, unknown>): CheckRow {
	const value = record(receipt.verification);
	const state = string(value?.state);
	const basis = string(value?.basis);
	if (!value || !state)
		return NOT_RECORDED(
			"verification",
			"Verification",
			VERIFICATION_SOURCE,
			"This receipt carries no verification state.",
		);
	const meaning =
		basis === "validation-tool"
			? state === "verified"
				? "A validation tool ran and passed."
				: "A validation tool ran and did not pass."
			: basis === "no-validation-tool"
				? "No validation tool ran, so nothing confirms the result."
				: basis === "read-only-agent"
					? "A read-only agent changes nothing, so there is nothing to verify."
					: basis === "acp-external-unobserved"
						? "An external agent did the work where Clio Coder could not observe its checks."
						: basis === "receipt-unavailable"
							? "No sealed receipt could be read for this run."
							: `Recorded basis: ${basis ?? "none"}.`;
	const [tone, word]: [StatusTone, string] =
		state === "verified"
			? ["success", "Verified"]
			: state === "not_applicable"
				? ["neutral", "Not applicable"]
				: state === "unverified"
					? ["unverified", "Unverified"]
					: ["unverified", state === "unknown" ? "Unknown" : state];
	return { key: "verification", label: "Verification", tone, word, meaning, source: VERIFICATION_SOURCE, items: [] };
}

const TYPED_SOURCE = "Observed by Clio Coder from validation tool results. A worker's own report never fills this.";

function typedChecks(quality: Record<string, unknown> | null): CheckRow {
	if (!quality || !Array.isArray(quality.typedValidations))
		return NOT_RECORDED("typed", "Executed checks", TYPED_SOURCE, "This receipt carries no typed validation list.");
	const items = keyed(
		quality.typedValidations.map((entry): Omit<CheckItem, "id"> => {
			const fact = record(entry);
			const passed = fact?.passed;
			return {
				name: sourceName(fact?.sourceId),
				tone: passed === true ? "success" : passed === false ? "fail" : "unverified",
				word: passed === true ? "Passed" : passed === false ? "Failed" : "Not recorded",
				facts: [shortDigest(fact?.validatorDigest)].filter((item): item is string => item !== null),
			};
		}),
	);
	if (items.length === 0)
		return {
			key: "typed",
			label: "Executed checks",
			tone: "unverified",
			word: "None ran",
			meaning: "No typed validation ran during this run.",
			source: TYPED_SOURCE,
			items,
		};
	const failed = items.filter((item) => item.tone === "fail").length;
	const passed = items.filter((item) => item.tone === "success").length;
	const unknown = items.length - failed - passed;
	const parts = [
		failed ? `${failed} failed` : "",
		passed ? `${passed} passed` : "",
		unknown ? `${unknown} not recorded` : "",
	].filter(Boolean);
	return {
		key: "typed",
		label: "Executed checks",
		tone: failed ? "fail" : unknown ? "unverified" : "success",
		word: parts.join(" · "),
		meaning: `${plural(items.length, "typed check")} ran and reported a result.`,
		source: TYPED_SOURCE,
		items,
	};
}

const HOST_SOURCE =
	"Run by Clio Coder on the settled tree after the worker finished. A worker's own report never fills this.";

const HOST_REASONS: Record<string, string> = {
	worker_not_successful: "The worker did not succeed, so the declared checks did not run.",
};

function hostChecks(receipt: Record<string, unknown>): CheckRow {
	const value = record(receipt.hostVerification);
	if (!value)
		return {
			key: "host",
			label: "Host checks",
			tone: "neutral",
			word: "None declared",
			meaning: "This run declared no checks for Clio Coder to run on its result.",
			source: HOST_SOURCE,
			items: [],
		};
	const status = string(value.status);
	const reason = string(value.reason);
	const items = keyed(
		(Array.isArray(value.checks) ? value.checks : []).map((entry): Omit<CheckItem, "id"> => {
			const check = record(entry);
			const exit = typeof check?.exitCode === "number" ? check.exitCode : null;
			const duration = count(check?.durationMs);
			const evidence = string(check?.evidenceRunId);
			const tail = string(check?.outputTail);
			return {
				name: string(check?.check) ?? "Unnamed check",
				tone: exit === 0 ? "success" : exit === null ? "unverified" : "fail",
				word: exit === 0 ? "Passed" : exit === null ? "Not recorded" : "Failed",
				facts: [
					exit === null ? "exit not recorded" : `exit ${exit}`,
					duration === null ? "" : `${duration} ms`,
					check?.memo === true ? "reused result" : "",
					evidence ? `evidence from run ${evidence}` : "",
				].filter(Boolean),
				...(tail ? { output: tail } : {}),
			};
		}),
	);
	const batch =
		value.strategy === "batch-settled" ? " They ran once for the whole batch after every member finished." : "";
	const [tone, word, meaning]: [StatusTone, string, string] =
		status === "verified"
			? ["success", "Passed", `Every declared check passed.${batch}`]
			: status === "rejected"
				? ["fail", "Rejected", `A declared check rejected the result.${batch}`]
				: status === "skipped"
					? [
							"neutral",
							"Skipped",
							(reason && HOST_REASONS[reason]) ?? `The declared checks did not run${reason ? ` (${reason})` : ""}.`,
						]
					: status === "not_implicated"
						? [
								"neutral",
								"Not charged",
								`A declared check failed for the batch, and the failure was charged to another run.${batch}`,
							]
						: ["unverified", status ?? "Not recorded", "This receipt carries a host check state this build does not know."];
	return { key: "host", label: "Host checks", tone, word, meaning, source: HOST_SOURCE, items };
}

const CONTRACT_SOURCE =
	"Checked by Clio Coder against the agent's declared result contract when the receipt was sealed.";

function contract(quality: Record<string, unknown> | null): CheckRow[] {
	if (!quality || !("resultContract" in quality))
		return [
			NOT_RECORDED("conformance", "Result format", CONTRACT_SOURCE, "This receipt carries no result-contract fact."),
			NOT_RECORDED("quality", "Result quality", CONTRACT_SOURCE, "This receipt carries no result-contract fact."),
		];
	const fact = record(quality.resultContract);
	if (!fact)
		return [
			{
				key: "conformance",
				label: "Result format",
				tone: "neutral",
				word: "No contract",
				meaning: "No result contract applied to this run, so neither format nor quality was judged.",
				source: CONTRACT_SOURCE,
				items: [],
			},
		];
	const name = contractName(fact.sourceId);
	const named = name ? `the ${name} contract` : "its result contract";
	const digest = shortDigest(fact.validatorDigest);
	const conformance = string(fact.conformance);
	const label = string(fact.quality);
	const [formTone, formWord, formMeaning]: [StatusTone, string, string] =
		conformance === "pass"
			? ["success", "Conforms", `The final result has the shape ${named} requires. Shape is not correctness.`]
			: conformance === "fail"
				? ["fail", "Does not conform", `The final result does not have the shape ${named} requires.`]
				: conformance === "not-reached"
					? ["neutral", "Not reached", `The run ended before a final result was due, so ${named} was not checked.`]
					: [
							"unverified",
							conformance ?? "Not recorded",
							"This receipt carries a conformance state this build does not know.",
						];
	const [qualityTone, qualityWord, qualityMeaning]: [StatusTone, string, string] =
		label === "pass"
			? ["success", "Passed", `The correctness checks in ${named} passed.`]
			: label === "fail"
				? ["fail", "Failed", `The correctness checks in ${named} failed.`]
				: label === "unmeasured"
					? [
							"unverified",
							"Not measured",
							conformance === "not-reached"
								? "Nothing was judged, so quality is unknown."
								: conformance === "fail"
									? "The result did not conform, so its quality was never measured."
									: "No correctness check was measured for this result. Conforming to the contract is not a quality pass.",
						]
					: ["unverified", label ?? "Not recorded", "This receipt carries a quality label this build does not know."];
	const exact = [name ? `${name} contract` : "result contract", digest].filter(Boolean).join(" · ");
	return [
		{
			key: "conformance",
			label: "Result format",
			tone: formTone,
			word: formWord,
			meaning: formMeaning,
			source: CONTRACT_SOURCE,
			exact,
			items: [],
		},
		{
			key: "quality",
			label: "Result quality",
			tone: qualityTone,
			word: qualityWord,
			meaning: qualityMeaning,
			source: CONTRACT_SOURCE,
			items: [],
		},
	];
}

const SCHEMA_SOURCE = "Reported by the model runtime when it enforces a response schema.";

function schema(quality: Record<string, unknown> | null): CheckRow {
	const fact = record(quality?.responseSchema);
	if (!fact)
		return NOT_RECORDED("schema", "Response schema", SCHEMA_SOURCE, "This receipt carries no response-schema fact.");
	if (fact.runtimeEnforceable !== true)
		return {
			key: "schema",
			label: "Response schema",
			tone: "neutral",
			word: "Not enforced",
			meaning: "The runtime did not enforce a response schema for this run.",
			source: SCHEMA_SOURCE,
			items: [],
		};
	const [tone, word, meaning]: [StatusTone, string, string] =
		fact.enforcementPassed === true
			? ["success", "Enforced · passed", "The runtime enforced the response schema and the response satisfied it."]
			: fact.enforcementPassed === false
				? ["fail", "Enforced · failed", "The runtime enforced the response schema and the response did not satisfy it."]
				: ["unverified", "Not measured", "The runtime could enforce a schema, but no result was recorded."];
	return { key: "schema", label: "Response schema", tone, word, meaning, source: SCHEMA_SOURCE, items: [] };
}

const GROUNDING_SOURCE =
	"The worker's own claims of passing checks, matched against commands its tool calls show it ran.";

function grounding(receipt: Record<string, unknown>): CheckRow {
	const value = record(receipt.validationGrounding);
	if (!value)
		return {
			key: "grounding",
			label: "Claimed checks",
			tone: "neutral",
			word: "None claimed",
			meaning: "The final result claimed no passing check that could be matched to a command.",
			source: GROUNDING_SOURCE,
			items: [],
		};
	const claimed = count(value.claimed);
	const grounded = count(value.grounded);
	const names = (Array.isArray(value.ungrounded) ? value.ungrounded : [])
		.map((name) => string(name))
		.filter((name): name is string => name !== null);
	const basis = string(value.basis);
	const items = keyed(names.map((name) => ({ name, tone: "fail", word: "No matching command", facts: [] })));
	if (claimed === null || grounded === null)
		return NOT_RECORDED(
			"grounding",
			"Claimed checks",
			GROUNDING_SOURCE,
			"This receipt carries an unreadable grounding record.",
		);
	const word = `${grounded} of ${plural(claimed, "claim")} grounded`;
	if (grounded >= claimed && names.length === 0)
		return {
			key: "grounding",
			label: "Claimed checks",
			tone: "success",
			word,
			meaning: "Every passing check the result claimed matches a command the run executed.",
			source: GROUNDING_SOURCE,
			items,
		};
	const [tone, meaning]: [StatusTone, string] =
		basis === "no-command-executed"
			? [
					"fail",
					"The result claimed a passing check, and the run executed no command that could have produced it. Its quality label does not rest on these claims.",
				]
			: basis === "unmatched-command"
				? [
						"warn",
						"The run executed commands the detector does not recognise, so these claims could not be matched. This is reported and not held against the run.",
					]
				: ["warn", `Some claims have no matching command. Recorded basis: ${basis ?? "none"}.`];
	return { key: "grounding", label: "Claimed checks", tone, word, meaning, source: GROUNDING_SOURCE, items };
}

/** Every row, in the order a reader asks: did it verify, what ran, was the result the right shape, was it good, what was claimed. */
export function receiptChecks(receipt: Record<string, unknown>): CheckRow[] {
	const quality = record(receipt.quality);
	return [
		verification(receipt),
		typedChecks(quality),
		hostChecks(receipt),
		...contract(quality),
		grounding(receipt),
		schema(quality),
	];
}
