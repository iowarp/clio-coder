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
import { ALL_TOOL_NAMES } from "../../src/core/tool-names.js";
import { createRunEffectsRecorder, toolWritesOpaquely } from "../../src/domains/safety/run-effects.js";

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

	// -------------------------------------------------------------------------
	// Whether the path set is a closed list or a lower bound
	// -------------------------------------------------------------------------

	it("names exactly the tools whose successful call can write a path their arguments do not", () => {
		// The list a reader has to trust, derived rather than authored: every
		// registered tool outside the read and write action classes. `git` is on
		// the EXECUTE plane but is a closed status/diff/log surface, so the
		// classifier calls it read class and it stays enumerable.
		deepStrictEqual(ALL_TOOL_NAMES.filter(toolWritesOpaquely), ["bash", "verify", "dispatch", "steer"]);
		// A dynamic or MCP tool has no schema this process can read, so it is
		// opaque by default rather than by omission.
		strictEqual(toolWritesOpaquely("mcp__server__do_something"), true);
	});

	it("reports a closed write record for a run that only used enumerable tools", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "write", { path: "src/a.ts", content: "x" });
		recorder.finish("call-1", false);
		recorder.start("call-2", "read", { path: "src/b.ts" });
		recorder.finish("call-2", false);
		recorder.start("call-3", "git", { op: "diff" });
		recorder.finish("call-3", false);
		strictEqual(recorder.snapshot().writeRecordComplete, true);
	});

	it("downgrades the whole run's record once one opaque call succeeds", () => {
		for (const tool of ["bash", "verify", "dispatch", "steer"]) {
			const notices: unknown[] = [];
			const recorder = createRunEffectsRecorder(CWD, {
				onWriteRecordDowngraded: (downgrade) => notices.push(downgrade),
			});
			recorder.start("call-1", "write", { path: "src/a.ts", content: "x" });
			recorder.finish("call-1", false);
			recorder.start("call-2", tool, { command: "npm run build" });
			recorder.finish("call-2", false);
			const effects = recorder.snapshot();
			strictEqual(effects.writeRecordComplete, false, `${tool} leaves the record open`);
			deepStrictEqual(effects.writeRecordDowngrades, [{ reason: "opaque_tool_succeeded", tool, toolCallId: "call-2" }]);
			deepStrictEqual(notices, effects.writeRecordDowngrades);
			// The path set itself is unchanged: it is still every path the run was
			// seen aiming a mutation at, now read as a lower bound.
			deepStrictEqual([...effects.mutatedPaths], abs("src/a.ts"));
		}
	});

	it("warns only when the first successful opaque call opens the record", () => {
		const notices: unknown[] = [];
		const recorder = createRunEffectsRecorder(CWD, {
			onWriteRecordDowngraded: (downgrade) => notices.push(downgrade),
		});
		for (const [toolCallId, tool] of [
			["call-1", "bash"],
			["call-2", "verify"],
		] as const) {
			recorder.start(toolCallId, tool, {});
			recorder.finish(toolCallId, false);
		}
		deepStrictEqual(notices, [{ reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-1" }]);
		deepStrictEqual(recorder.snapshot().writeRecordDowngrades, [
			{ reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-1" },
			{ reason: "opaque_tool_succeeded", tool: "verify", toolCallId: "call-2" },
		]);
	});

	it("leaves the record closed when the opaque call never landed", () => {
		// A shell command the safety policy blocked, or one that came back an
		// error, reached no filesystem, so it cannot have hidden a write.
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "bash", { command: "rm -rf /" });
		recorder.finish("call-1", true);
		strictEqual(recorder.snapshot().writeRecordComplete, true);
	});

	it("tracks an opaque call that exposed no path and no command at all", () => {
		const recorder = createRunEffectsRecorder(CWD);
		recorder.start("call-1", "dispatch", { agent: "coder", task: "do the thing" });
		recorder.finish("call-1", false);
		const effects = recorder.snapshot();
		strictEqual(effects.writeRecordComplete, false);
		strictEqual(effects.mutatedPaths.size, 0);
	});
});
