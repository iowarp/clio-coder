/**
 * The redacted action descriptor and the seams that compose it.
 *
 * The rule this file exists to hold: a worker's tool arguments never cross the
 * NDJSON stdout boundary, and what does cross is a bounded verb plus an object
 * drawn from a fixed field allowlist with secrets scrubbed. Every assertion
 * here is about what a descriptor may and may not contain, because the
 * descriptor is the only argument-derived text an operator surface ever reads.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CALL_ACTION_OBJECT_MAX_CHARS,
	describeCallAction,
	sanitizeCallTargetText,
} from "../../src/domains/safety/call-target.js";
import { AcpEventMapper } from "../../src/engine/acp/event-mapper.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import type { ToolStartEvent } from "../../src/tools/agent-tools.js";

const ESC = String.fromCharCode(27);

describe("worker action descriptor", () => {
	it("names the verb and object of every tool Clio ships", () => {
		deepStrictEqual(describeCallAction("read", { path: "src/app.ts" }), { verb: "reading", object: "src/app.ts" });
		deepStrictEqual(describeCallAction("bash", { command: "npm test" }), { verb: "running", object: "npm test" });
		deepStrictEqual(describeCallAction("grep", { pattern: "TODO" }), { verb: "searching", object: "TODO" });
		deepStrictEqual(describeCallAction("web_fetch", { url: "https://example.com/a" }), {
			verb: "fetching",
			object: "https://example.com/a",
		});
	});

	it("reads only allowlisted fields, so an argument the table does not name cannot leak", () => {
		const descriptor = describeCallAction("write", {
			path: "notes.md",
			content: "the entire file body that must never travel",
			env: { OPENAI_API_KEY: "sk-live-1234" },
		});
		deepStrictEqual(descriptor, { verb: "writing", object: "notes.md" });
	});

	it("falls back to no object rather than dumping arguments for a known tool", () => {
		deepStrictEqual(describeCallAction("read", { offset: 12, limit: 40 }), { verb: "reading" });
	});

	it("returns nothing at all for an unknown tool with no allowlisted field", () => {
		strictEqual(describeCallAction("mcp__vendor__thing", { payload: { token: "sk-live" } }), null);
	});

	it("gives an unknown tool the neutral verb when an allowlisted field is present", () => {
		deepStrictEqual(describeCallAction("mcp__fs__cat", { path: "/etc/hosts" }), {
			verb: "calling",
			object: "/etc/hosts",
		});
	});

	it("scrubs credentials out of the object it does carry", () => {
		const flag = describeCallAction("bash", { command: "curl --api-key sk-live-abcdef https://api.example.com" });
		ok(flag?.object !== undefined);
		ok(!flag.object.includes("sk-live-abcdef"), flag.object);
		ok(flag.object.includes("[redacted]"), flag.object);

		const url = describeCallAction("web_fetch", { url: "https://example.com/x?access_token=hunter2" });
		ok(url?.object !== undefined);
		ok(!url.object.includes("hunter2"), url.object);

		const assignment = describeCallAction("bash", { command: "AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls" });
		ok(assignment?.object !== undefined);
		ok(!assignment.object.includes("abc123"), assignment.object);
	});

	it("bounds the object and marks the cut", () => {
		const long = "x".repeat(CALL_ACTION_OBJECT_MAX_CHARS * 4);
		const descriptor = describeCallAction("read", { path: long });
		strictEqual(descriptor?.object?.length, CALL_ACTION_OBJECT_MAX_CHARS);
		strictEqual(descriptor?.truncated, true);
	});

	it("neutralizes escape sequences and newlines so a hostile path cannot paint the board", () => {
		const hostile = `${ESC}[2J${ESC}]0;pwned${String.fromCharCode(7)}first\nsecond`;
		const descriptor = describeCallAction("read", { path: hostile });
		ok(descriptor?.object !== undefined);
		ok(!descriptor.object.includes(ESC), JSON.stringify(descriptor.object));
		ok(!descriptor.object.includes("\n"), JSON.stringify(descriptor.object));
		strictEqual(descriptor.object, sanitizeCallTargetText(descriptor.object));
	});
});

describe("action descriptor transport", () => {
	it("rides the ACP tool start event without the peer's raw input", () => {
		const mapper = new AcpEventMapper();
		const events = mapper.mapUpdate({
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Read file",
				kind: "read",
				status: "in_progress",
				rawInput: { path: "src/app.ts", authorization: "Bearer sk-live-9" },
			},
		});
		const start = events.find(
			(event): event is Extract<ClioWorkerEvent, { type: "clio_tool_start" }> =>
				(event as { type?: unknown }).type === "clio_tool_start",
		);
		const payload = start?.payload as ToolStartEvent | undefined;
		deepStrictEqual(payload?.action, { verb: "reading", object: "src/app.ts" });
		ok(!JSON.stringify(payload).includes("sk-live-9"), JSON.stringify(payload));
	});
});
