/**
 * Corpus loading, hashing, and the holdout lock.
 *
 * Holdout isolation is a code contract here, not a convention. There is no
 * exported path that returns holdout scenarios without a freeze record, and
 * the freeze record pins the exact arm build and prompt hashes the holdouts
 * may run against. An arm whose prompt moved after the freeze cannot reach the
 * holdouts at all, which is what makes "holdouts pass without post-hoc prompt
 * edits" a checkable claim rather than a discipline everyone promises to keep.
 */
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import type {
	PromptAbArmIdentity,
	PromptAbCorpusId,
	PromptAbFreezeRecordV1,
	PromptAbPhase,
	PromptAbScenario,
} from "./contract.js";
import { PROMPT_AB_FREEZE_SCHEMA_V1, PROMPT_AB_HARNESS_VERSION } from "./contract.js";
import { DEVELOPMENT_SCENARIOS } from "./corpus-development.js";
import { HOLDOUT_SCENARIOS } from "./corpus-holdout.js";

export class PromptAbHoldoutLockedError extends Error {
	constructor(reason: string) {
		super(`prompt-ab holdout corpus is locked: ${reason}`);
		this.name = "PromptAbHoldoutLockedError";
	}
}

/** Identity of one scenario, covering everything a trial's meaning depends on. */
export function promptAbScenarioHash(scenario: PromptAbScenario): string {
	return sha256(canonicalJson(scenario));
}

/** Identity of a whole corpus, in declaration order. Freezing pins this value. */
export function promptAbCorpusHash(scenarios: readonly PromptAbScenario[]): string {
	return sha256(canonicalJson(scenarios.map(promptAbScenarioHash)));
}

/** The development corpus. Readable in either phase; this is what tuning is allowed to see. */
export function developmentCorpus(): readonly PromptAbScenario[] {
	return DEVELOPMENT_SCENARIOS;
}

/**
 * The holdout corpus, reachable only through a freeze record whose arm
 * identities match the arms about to run. Every rejection names what moved.
 */
export function holdoutCorpus(
	freeze: PromptAbFreezeRecordV1,
	arms: readonly PromptAbArmIdentity[],
): readonly PromptAbScenario[] {
	assertFreezeRecordShape(freeze);
	if (freeze.holdoutCorpusHash !== promptAbCorpusHash(HOLDOUT_SCENARIOS)) {
		throw new PromptAbHoldoutLockedError("the holdout corpus changed after the freeze was taken");
	}
	if (freeze.developmentCorpusHash !== promptAbCorpusHash(DEVELOPMENT_SCENARIOS)) {
		throw new PromptAbHoldoutLockedError("the development corpus changed after the freeze was taken");
	}
	for (const arm of arms) {
		const frozen = freeze.arms.find((entry) => entry.id === arm.id);
		if (frozen === undefined) {
			throw new PromptAbHoldoutLockedError(`arm ${arm.id} is not in the freeze record`);
		}
		if (frozen.promptFragmentsHash !== arm.promptFragmentsHash) {
			throw new PromptAbHoldoutLockedError(
				`arm ${arm.id} prompt fragments changed after the freeze (post-hoc prompt edit)`,
			);
		}
		if (frozen.buildHash !== arm.buildHash) {
			throw new PromptAbHoldoutLockedError(`arm ${arm.id} build changed after the freeze`);
		}
		if (frozen.toolCatalogHash !== arm.toolCatalogHash) {
			throw new PromptAbHoldoutLockedError(`arm ${arm.id} tool catalog changed after the freeze`);
		}
	}
	return HOLDOUT_SCENARIOS;
}

export interface LoadPromptAbCorpusInput {
	corpus: PromptAbCorpusId;
	phase: PromptAbPhase;
	arms: readonly PromptAbArmIdentity[];
	freeze: PromptAbFreezeRecordV1 | null;
}

/**
 * The single entry point a runner uses to obtain scenarios.
 *
 * Asking for holdouts during tuning is refused before any arm is inspected, so
 * a tuning run cannot even learn how many holdout scenarios exist.
 */
export function loadPromptAbCorpus(input: LoadPromptAbCorpusInput): readonly PromptAbScenario[] {
	if (input.corpus === "development") {
		if (input.phase === "frozen" && input.freeze === null) {
			throw new PromptAbHoldoutLockedError("a frozen-phase run needs the freeze record it was frozen against");
		}
		return developmentCorpus();
	}
	if (input.phase !== "frozen") {
		throw new PromptAbHoldoutLockedError("holdouts are unavailable during tuning; freeze the arms first");
	}
	if (input.freeze === null) {
		throw new PromptAbHoldoutLockedError("holdouts need a freeze record naming the arms they may run against");
	}
	return holdoutCorpus(input.freeze, input.arms);
}

export interface BuildPromptAbFreezeInput {
	experimentId: string;
	arms: readonly PromptAbArmIdentity[];
	note: string;
	frozenAt: string;
}

/** Take the freeze. Recording both corpus hashes is what makes a later drift visible. */
export function buildPromptAbFreezeRecord(input: BuildPromptAbFreezeInput): PromptAbFreezeRecordV1 {
	if (input.arms.length === 0) throw new Error("a freeze record must name at least one arm");
	return {
		schema: PROMPT_AB_FREEZE_SCHEMA_V1,
		harnessVersion: PROMPT_AB_HARNESS_VERSION,
		experimentId: input.experimentId,
		frozenAt: input.frozenAt,
		developmentCorpusHash: promptAbCorpusHash(DEVELOPMENT_SCENARIOS),
		holdoutCorpusHash: promptAbCorpusHash(HOLDOUT_SCENARIOS),
		arms: input.arms.map((arm) => ({ ...arm })),
		note: input.note,
	};
}

export function parsePromptAbFreezeRecord(value: unknown): PromptAbFreezeRecordV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PromptAbHoldoutLockedError("freeze record is not an object");
	}
	const record = value as PromptAbFreezeRecordV1;
	assertFreezeRecordShape(record);
	return record;
}

function assertFreezeRecordShape(freeze: PromptAbFreezeRecordV1): void {
	if (freeze.schema !== PROMPT_AB_FREEZE_SCHEMA_V1) {
		throw new PromptAbHoldoutLockedError(`freeze record schema must be ${PROMPT_AB_FREEZE_SCHEMA_V1}`);
	}
	if (freeze.harnessVersion !== PROMPT_AB_HARNESS_VERSION) {
		throw new PromptAbHoldoutLockedError(`freeze record was written by harness version ${freeze.harnessVersion}`);
	}
	if (!Array.isArray(freeze.arms) || freeze.arms.length === 0) {
		throw new PromptAbHoldoutLockedError("freeze record names no arms");
	}
	for (const field of ["developmentCorpusHash", "holdoutCorpusHash"] as const) {
		if (typeof freeze[field] !== "string" || !/^[a-f0-9]{64}$/u.test(freeze[field])) {
			throw new PromptAbHoldoutLockedError(`freeze record ${field} is not a sha256 digest`);
		}
	}
}
