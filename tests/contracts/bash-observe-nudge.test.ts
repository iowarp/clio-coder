import { ok, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { bashTool } from "../../src/tools/bash.js";

const NUDGE = "[note: prefer the structured observe tools over shell file inspection:";

function sessionId(label: string): string {
	return `bash-nudge-${label}-${randomUUID()}`;
}

function output(result: Awaited<ReturnType<typeof bashTool.run>>): string {
	if (result.kind !== "ok") throw new Error(`expected ok bash result, got ${result.kind}`);
	return result.output;
}

describe("contracts/bash observe-tool result nudge", () => {
	it("adds the observe-tool note only to the first matching success per session", async () => {
		const session = sessionId("A");

		const first = await bashTool.run({ command: "ls package.json" }, { sessionId: session });
		const second = await bashTool.run({ command: "ls package.json" }, { sessionId: session });

		strictEqual(first.kind, "ok");
		strictEqual(second.kind, "ok");
		ok(output(first).includes(NUDGE), "first observer-shaped bash call carries the nudge");
		ok(output(first).includes("read pages files"), "the note names read");
		ok(output(first).includes("ls lists directories"), "the note names ls");
		ok(output(first).includes("grep and find search"), "the note names grep/find");
		ok(output(first).includes("code_nav maps symbols"), "the note names code_nav");
		ok(!output(second).includes(NUDGE), "second observer-shaped bash call in the same session is not nudged");
	});

	it("adds the note again for a fresh session", async () => {
		const result = await bashTool.run({ command: "ls package.json" }, { sessionId: sessionId("B") });

		strictEqual(result.kind, "ok");
		ok(output(result).includes(NUDGE));
	});

	it("does not nudge non-observer commands", async () => {
		const result = await bashTool.run({ command: "printf hi" }, { sessionId: sessionId("printf") });

		strictEqual(result.kind, "ok");
		strictEqual(output(result), "hi");
	});

	it("does not nudge failing observer commands", async () => {
		const result = await bashTool.run(
			{ command: `ls definitely-missing-${randomUUID()}` },
			{ sessionId: sessionId("failing") },
		);

		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			ok(!result.message.includes(NUDGE));
		}
	});
});
