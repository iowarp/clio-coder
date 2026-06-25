/**
 * One evidence spine (Slice 1): the live finish-contract layer is a documented
 * projection of the forensic evidence taxonomy. This contract pins that the
 * projection stays total over every `FinishContractEvidenceKind` and that each
 * mapped value is a real `EvidenceTag` from the canonical `EVIDENCE_TAGS`.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FINISH_CONTRACT_EVIDENCE_TAGS,
	finishContractEvidenceTags,
} from "../../src/domains/evidence/finish-contract-map.js";
import { EVIDENCE_TAGS } from "../../src/domains/evidence/index.js";
import type { FinishContractEvidenceKind } from "../../src/domains/safety/finish-contract.js";

/**
 * The full set of live evidence kinds. The `satisfies` clause makes this a
 * compile-time exhaustiveness guard: if `FinishContractEvidenceKind` gains or
 * loses a member, this array stops type-checking until it is updated, which
 * keeps the runtime totality assertion below honest.
 */
const ALL_FINISH_CONTRACT_KINDS = [
	"validation_command",
	"protected_artifact",
	"dispatch_receipt",
	"requested_inspection",
] as const satisfies readonly FinishContractEvidenceKind[];

const tagSet = new Set<string>(EVIDENCE_TAGS);

describe("contracts/finish-contract-map", () => {
	it("maps every finish-contract kind onto at least one canonical tag", () => {
		const mappedKinds = Object.keys(FINISH_CONTRACT_EVIDENCE_TAGS).sort();
		const expectedKinds = [...ALL_FINISH_CONTRACT_KINDS].sort();
		deepStrictEqual(mappedKinds, expectedKinds);

		for (const kind of ALL_FINISH_CONTRACT_KINDS) {
			const tags = finishContractEvidenceTags(kind);
			ok(Array.isArray(tags), `expected an array for kind ${kind}`);
			ok(tags.length > 0, `kind ${kind} must project onto at least one tag`);
		}
	});

	it("projects only real members of EVIDENCE_TAGS", () => {
		for (const kind of ALL_FINISH_CONTRACT_KINDS) {
			for (const tag of finishContractEvidenceTags(kind)) {
				ok(tagSet.has(tag), `kind ${kind} maps unknown tag ${tag}`);
			}
		}
	});

	it("is stable: the accessor returns the same projection as the table", () => {
		for (const kind of ALL_FINISH_CONTRACT_KINDS) {
			deepStrictEqual(finishContractEvidenceTags(kind), FINISH_CONTRACT_EVIDENCE_TAGS[kind]);
		}
		strictEqual(Object.keys(FINISH_CONTRACT_EVIDENCE_TAGS).length, ALL_FINISH_CONTRACT_KINDS.length);
	});
});
