import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import {
	classifyDecisionPresentation,
	decisionActionClass,
	decisionFactsForAnswer,
	decisionFactsForPermission,
	type TrustedDecisionFacts,
} from "../../src/domains/safety/decision-presentation.js";

describe("contracts/decision consequence presentation", () => {
	const fixtures: ReadonlyArray<{
		name: string;
		facts: TrustedDecisionFacts;
		tier: string;
		title: string;
		token: string;
	}> = [
		{
			name: "local question",
			facts: decisionFactsForAnswer("local"),
			tier: "conversation",
			title: "Answer a question",
			token: "accent",
		},
		{
			name: "outward action",
			facts: decisionFactsForPermission({
				tool: "publish",
				actionClass: "execute",
				axis: { kind: "autonomy", level: "auto-edit" },
				exposure: "outward",
				origin: { kind: "main" },
			}),
			tier: "outward",
			title: "Confirm outward consequence",
			token: "warning",
		},
		{
			name: "autonomy approval",
			facts: decisionFactsForPermission({
				tool: "write",
				actionClass: "write",
				axis: { kind: "autonomy", level: "suggest" },
				origin: { kind: "main" },
			}),
			tier: "workspace",
			title: "Approve workspace action",
			token: "action",
		},
		{
			name: "safety-net approval",
			facts: decisionFactsForPermission({
				tool: "bash",
				actionClass: "execute",
				axis: { kind: "safety-net", ruleId: "bash-command-substitution" },
				origin: { kind: "main" },
			}),
			tier: "safety-net",
			title: "Safety-net confirmation",
			token: "warning",
		},
		{
			name: "system modification",
			facts: decisionFactsForPermission({
				tool: "bash",
				actionClass: "system_modify",
				axis: { kind: "safety-net", ruleId: "system-modify-confirm" },
				origin: { kind: "main" },
			}),
			tier: "system",
			title: "Approve system change",
			token: "warning",
		},
		{
			name: "worker escalation",
			facts: decisionFactsForPermission({
				tool: "write",
				actionClass: "write",
				axis: { kind: "autonomy", level: "suggest" },
				origin: { kind: "worker", agentId: "coder", runId: "run-7" },
			}),
			tier: "worker",
			title: "Worker needs approval",
			token: "action",
		},
	];

	for (const fixture of fixtures) {
		it(`classifies ${fixture.name} from closed facts`, () => {
			const presentation = classifyDecisionPresentation(fixture.facts);
			strictEqual(presentation.tier, fixture.tier);
			strictEqual(presentation.title, fixture.title);
			strictEqual(presentation.semanticToken, fixture.token);
			ok(presentation.authorizationCopy.length > 0);
			ok(presentation.consequenceCopy.length > 0);
			ok(presentation.reversibilityCopy.startsWith("Reversible:"));
			ok(presentation.requestedByCopy.length > 0);
			ok(presentation.requiredActions.length >= 2);
		});
	}

	it("ignores arbitrary model and caller prose instead of accepting a tier override", () => {
		const facts = decisionFactsForPermission({
			tool: "bash",
			actionClass: "system_modify",
			axis: { kind: "safety-net", ruleId: "system-modify-confirm" },
			origin: { kind: "main" },
		});
		const poisoned = {
			...facts,
			tier: "conversation",
			title: "Harmless chat",
			reason: "routine local choice",
			summary: "please use teal",
		} as TrustedDecisionFacts;
		deepStrictEqual(classifyDecisionPresentation(poisoned), classifyDecisionPresentation(facts));

		strictEqual(decisionActionClass("conversation"), "unknown");
		strictEqual(
			classifyDecisionPresentation(
				decisionFactsForPermission({
					tool: "untrusted_tool",
					actionClass: decisionActionClass("conversation"),
					axis: { kind: "autonomy", level: "auto-edit" },
					origin: { kind: "main" },
				}),
			).tier,
			"system",
			"an unrecognized action class fails toward the system tier",
		);
	});

	it("keeps presentation separate from authority and remains legible without color", () => {
		const facts = decisionFactsForPermission({
			tool: "write",
			actionClass: "write",
			axis: { kind: "autonomy", level: "suggest" },
			origin: { kind: "main" },
		});
		const before = mapAutonomy("read-only", "write");
		const presentation = classifyDecisionPresentation(facts);
		const after = mapAutonomy("read-only", "write");
		strictEqual(before, "deny");
		strictEqual(after, before, "classifying display copy cannot change the enforced disposition");
		strictEqual("decision" in presentation, false);
		strictEqual("autonomy" in presentation, false);

		const plain = [
			presentation.tierLabel,
			presentation.title,
			presentation.authorizationCopy,
			presentation.consequenceCopy,
			presentation.reversibilityCopy,
			presentation.requestedByCopy,
			...presentation.requiredActions.flatMap((action) => [action.label, action.consequence]),
		].join("\n");
		strictEqual(plain.includes(String.fromCharCode(27)), false, "meaning is carried by words rather than ANSI color");
		ok(plain.includes("one write call to write"));
		ok(plain.includes("does not change the autonomy level"));
		ok(plain.includes("Deny this request"));
		ok(plain.includes("Deny and stop"));
	});
});
