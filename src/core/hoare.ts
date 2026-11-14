import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const HOARE_ASSURANCES = ["argued", "modeled", "mechanized"] as const;
export type HoareAssurance = (typeof HOARE_ASSURANCES)[number];
export const HOARE_STATUSES = ["mechanized", "modeled", "argued", "assumed", "refuted", "unknown"] as const;
const text = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const closed = { additionalProperties: false };
const goalFields = {
	target: Type.String({ minLength: 3, maxLength: 512, pattern: "\\S+:\\S+" }),
	kind: id,
	pre: text,
	post: text,
	formula: text,
	invariant: Type.Optional(text),
	hazard: Type.Optional(id),
};
const machineStatus = Type.Union([Type.Literal("mechanized"), Type.Literal("modeled"), Type.Literal("refuted")]);

export const HoareObligationSchema = Type.Object(
	{
		...goalFields,
		status: Type.Union([
			Type.Literal("mechanized"),
			Type.Literal("modeled"),
			Type.Literal("argued"),
			Type.Literal("assumed"),
			Type.Literal("refuted"),
			Type.Literal("unknown"),
		]),
		check: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9._:-]{0,63}$" })),
	},
	closed,
);
export type HoareObligation = Static<typeof HoareObligationSchema>;

export const DeclaredProofSchema = Type.Object(
	{
		status: machineStatus,
		goals: Type.Array(Type.Object({ id, ...goalFields }, closed), { minItems: 1, maxItems: 128 }),
		inputs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
			minItems: 1,
			maxItems: 64,
			uniqueItems: true,
		}),
	},
	closed,
);
export type DeclaredProof = Static<typeof DeclaredProofSchema>;

export interface ObservedProof {
	check: string;
	toolCallId: string;
	proof: DeclaredProof;
	/** SHA-256 of the catalog and declared input fingerprints, in sorted path order. */
	snapshot: string;
}

export function isHoareAssurance(value: unknown): value is HoareAssurance {
	return typeof value === "string" && HOARE_ASSURANCES.some((level) => level === value);
}

export function parseHoareObligation(value: unknown): HoareObligation | Error {
	return Value.Check(HoareObligationSchema, value)
		? value
		: new Error(
				"obligation must contain target, kind, pre, post, formula, status and only optional invariant, hazard, check",
			);
}

export function hoarePasses(assurance: HoareAssurance, status: HoareObligation["status"]): boolean {
	return (
		status === "mechanized" ||
		(status === "modeled" && assurance !== "mechanized") ||
		(status === "argued" && assurance === "argued")
	);
}

function proofGoalMatches(goal: DeclaredProof["goals"][number], name: string, obligation: HoareObligation) {
	return (
		goal.id === name &&
		goal.target === obligation.target &&
		goal.kind === obligation.kind &&
		goal.pre === obligation.pre &&
		goal.post === obligation.post &&
		goal.formula === obligation.formula &&
		goal.invariant === obligation.invariant &&
		goal.hazard === obligation.hazard
	);
}

/** Only exact, current-run native check evidence can support a machine-result claim. */
export function hoareEvidenceError(
	name: string,
	obligation: HoareObligation,
	proofs: ReadonlyMap<string, ObservedProof> | undefined,
): string | null {
	const machineClaim =
		obligation.status === "mechanized" || obligation.status === "modeled" || obligation.check !== undefined;
	if (!machineClaim) return null;
	const observed = obligation.check === undefined ? undefined : proofs?.get(obligation.check);
	if (
		observed === undefined ||
		observed.proof.status !== obligation.status ||
		!observed.proof.goals.some((goal) => proofGoalMatches(goal, name, obligation))
	) {
		return `${name}: ${obligation.status} lacks a matching declared proof check that completed successfully in this run on unchanged inputs; use status unknown, passed false and verdict fail`;
	}
	return null;
}
