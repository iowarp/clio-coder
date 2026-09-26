import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { groundClaimedValidations } from "../../src/domains/dispatch/validation-grounding.js";
import { typedValidationSummary } from "../../src/domains/safety/finish-contract.js";
import { detectValidationCommand } from "../../src/domains/safety/protected-artifacts.js";

it("grounds package-manager test aliases in both directions without equating different scripts", () => {
	for (const manager of ["npm", "pnpm", "yarn"]) {
		for (const [claim, command] of [
			[`${manager} test`, `${manager} run test`],
			[`${manager} run test`, `${manager} test`],
		]) {
			const result = groundClaimedValidations({
				contractKind: "mutation-report",
				output: JSON.stringify({ validations: [{ name: claim, passed: true }] }),
				executedCommands: new Set([command as string]),
				executedCheckingCalls: 1,
			});
			strictEqual(result?.grounded, 1);
		}
	}
	for (const command of ["npm run testing", "npm run test:unit"]) {
		const result = groundClaimedValidations({
			contractKind: "mutation-report",
			output: '{"validations":[{"name":"npm test","passed":true}]}',
			executedCommands: new Set([command]),
			executedCheckingCalls: 1,
		});
		strictEqual(result?.grounded, 0);
	}
});

it("keeps punctuation and quoted validation claims grounded", () => {
	for (const [claim, command] of [
		["`npm test`", "npm test"],
		['"npm test"', "npm test"],
		["npm test: 12 passing", "npm test"],
		["npm test:", "npm run test"],
		["npm test, 12 passing", "npm test"],
		["pytest: 3 passed", "pytest"],
		["cargo test.", "cargo test"],
		["make check: ok", "make check"],
		["npm run lint: clean", "npm run lint"],
		["npm run testing; then npm run test, 12 passing", "npm run test"],
	]) {
		const result = groundClaimedValidations({
			contractKind: "mutation-report",
			output: JSON.stringify({ validations: [{ name: claim, passed: true }] }),
			executedCommands: new Set([command as string]),
			executedCheckingCalls: 1,
		});
		strictEqual(result?.grounded, 1, claim);
	}
});

it("grounds production package-manager executions and verify summaries", () => {
	for (const manager of ["npm", "pnpm", "yarn"]) {
		for (const spelling of [`${manager} test`, `${manager} run test`]) {
			const detected = detectValidationCommand(spelling);
			strictEqual(detected.kind, "validation", spelling);
			const recorded = detected.kind === "validation" ? detected.matched : "";
			for (const command of [recorded, typedValidationSummary("verify", { args: { check: "test" } }) as string]) {
				const result = groundClaimedValidations({
					contractKind: "mutation-report",
					output: JSON.stringify({ validations: [{ name: spelling, passed: true }] }),
					executedCommands: new Set([command]),
					executedCheckingCalls: 1,
				});
				strictEqual(result?.grounded, 1, spelling);
			}
		}
	}
});
