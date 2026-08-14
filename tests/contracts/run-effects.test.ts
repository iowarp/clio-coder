/**
 * The write-side evidence a mutation report is grounded against. The recorder
 * folds a run's own tool calls into the paths it changed and the validations it
 * ran; the result-contract validator turns that into conformance and quality.
 * These pin the recorder's two invariants: a call only counts once its result
 * comes back clean, and the path set is a superset of what the finish-contract
 * gate counts, because a path missing here can only produce a false failure.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";

const CWD = "/repo";

function abs(...parts: string[]): string[] {
	return parts.map((part) => path.resolve(CWD, part)).sort();
}

describe("contracts/run-effects", () => {
	it("records a write tool's path only after the call succeeds", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "write", { path: "src/a.ts", content: "x" });
		strictEqual(recorder.snapshot().mutatedPaths.size, 0);
		recorder.finish("call-1", false);
		deepStrictEqual([...recorder.snapshot().mutatedPaths], abs("src/a.ts"));
	});

	it("keeps a refused mutation apart from a completed one", () => {
		// Receipt 182h2ai478p5: the edit was refused by the worker permission
		// policy and the report still claimed the file. The file existed, so only
		// the failed tool result can tell the claim from the truth.
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "edit", { path: "src/a.ts" });
		recorder.start("call-2", "bash", { command: "npm test" });
		recorder.finish("call-1", true);
		recorder.finish("call-2", true);
		const effects = recorder.snapshot();
		strictEqual(effects.mutatedPaths.size, 0);
		deepStrictEqual([...effects.failedMutationPaths], abs("src/a.ts"));
		// A red command is not evidence that a check passed, so it cannot make a
		// self-reported validation measurable.
		strictEqual(effects.validationCommands.size, 0);
	});

	it("a retry that lands clears the earlier refusal", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "edit", { path: "src/a.ts" });
		recorder.finish("call-1", true);
		recorder.start("call-2", "write", { path: "src/a.ts", content: "x" });
		recorder.finish("call-2", false);
		const effects = recorder.snapshot();
		deepStrictEqual([...effects.mutatedPaths], abs("src/a.ts"));
		strictEqual(effects.failedMutationPaths.size, 0);
	});

	it("reads bash write, delete, and git path operands as mutations", () => {
		const recorder = createRunEffectsRecorder(CWD);
		const commands = ["echo hi > out.txt", "rm src/old.ts", "git mv src/from.ts src/to.ts", "sed -i s/a/b/ src/c.ts"];
		commands.forEach((command, index) => {
			recorder.start(`call-${index}`, "bash", { command });
			recorder.finish(`call-${index}`, false);
		});
		deepStrictEqual(
			[...recorder.snapshot().mutatedPaths].sort(),
			abs("out.txt", "src/old.ts", "src/from.ts", "src/to.ts", "src/c.ts"),
		);
	});

	it("resolves a bash call's relative targets against the call's own cwd", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "bash", { command: "touch note.md", cwd: "docs" });
		recorder.finish("call-1", false);
		deepStrictEqual([...recorder.snapshot().mutatedPaths], abs("docs/note.md"));
	});

	it("records validation commands from bash and from the verify tool", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "bash", { command: "npm test" });
		recorder.finish("call-1", false);
		recorder.start("call-2", "verify", { check: "typecheck" });
		recorder.finish("call-2", false);
		// A read stays out of both sets: it changes nothing and validates nothing.
		recorder.start("call-3", "read", { path: "src/a.ts" });
		recorder.finish("call-3", false);
		const effects = recorder.snapshot();
		deepStrictEqual([...effects.validationCommands].sort(), ["npm run typecheck", "npm test"]);
		strictEqual(effects.mutatedPaths.size, 0);
		// Everything the strict set holds is also a check under the wider scope.
		deepStrictEqual([...effects.verificationCommands].sort(), ["npm run typecheck", "npm test"]);
	});

	it("records read verification and ad-hoc checks only in the grounding set", () => {
		const recorder = createRunEffectsRecorder(CWD);
		const commands = ["git diff -- src/sum.ts", "npx vitest run", "node -e \"import('./src/sum.js')\""];
		commands.forEach((command, index) => {
			recorder.start(`call-${index}`, "bash", { command });
			recorder.finish(`call-${index}`, false);
		});
		const effects = recorder.snapshot();
		// The strict set is what `result-contract.ts` spends on the measured gate,
		// and a run that only looked at its own diff has asserted nothing about
		// correctness. Widening that set would let inspection seal a mutation
		// report as `pass`.
		strictEqual(effects.validationCommands.size, 0);
		deepStrictEqual([...effects.verificationCommands].sort(), ["git diff", "node -e", "npx vitest"]);
	});

	it("keeps a red grounding-scope command out of both sets", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "bash", { command: "npx vitest run" });
		recorder.finish("call-1", true);
		const effects = recorder.snapshot();
		strictEqual(effects.validationCommands.size, 0);
		strictEqual(effects.verificationCommands.size, 0);
	});
});
