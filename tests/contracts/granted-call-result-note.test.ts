import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { APPROVAL_NOTE_PREFIX, approvalNote, OPERATOR_APPROVAL_NOTE_PREFIX } from "../../src/tools/approval-note.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";

/**
 * BT-003. A one-shot grant left no trace in the result the model reads, so
 * after approving a damage-control confirmation the model told the operator the
 * call "executed immediately ... no prompt, no block". A denial already reaches
 * the model; only a grant was silent.
 *
 * Four surfaces release a parked call (`tool:one_shot` from the TUI card,
 * `acp-client`, `escalation:operator`, `escalation:remembered`), and only two
 * of them are this session's operator answering now. The note must say which.
 */
describe("a granted call tells the model who granted it", () => {
	let originalCwd: string;
	let base: string;
	let root: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-grant-note-")));
		root = join(base, "root");
		mkdirSync(join(root, "data"), { recursive: true });
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(base, { recursive: true, force: true });
	});

	function defaultRegistry() {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
		registry.register(writeTool);
		return registry;
	}

	async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
		let timer: NodeJS.Timeout | undefined;
		const pending = new Promise<"pending">((resolve) => {
			timer = setTimeout(() => resolve("pending"), ms);
		});
		try {
			return await Promise.race([promise, pending]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Park an outside-workspace write, release it from `requestedBy`, and return the model-facing text. */
	async function grantedText(requestedBy: string): Promise<string> {
		const registry = defaultRegistry();
		const asked: Array<{ actionClass: ActionClass; requestId: string }> = [];
		registry.onPermissionRequired((_call, decision, meta) => {
			asked.push({ actionClass: decision.classification.actionClass, requestId: meta.requestId });
		});
		const verdict = registry.invoke({ tool: ToolNames.Write, args: { path: "../outside.txt", content: "x" } });
		strictEqual(await settledWithin(verdict, 50), "pending");
		strictEqual(asked.length, 1);
		await registry.resumeParkedCalls({
			actionClass: asked[0]?.actionClass as ActionClass,
			requestId: asked[0]?.requestId as string,
			requestedBy,
		});
		const settled = await verdict;
		strictEqual(settled.kind, "ok", requestedBy);
		if (settled.kind !== "ok") return "";
		return settled.result.kind === "ok" ? settled.result.output : settled.result.message;
	}

	it("keeps the BT-003 operator wording for the TUI card", async () => {
		const text = await grantedText("tool:one_shot");
		ok(
			text.startsWith(
				"[operator approval] The operator approved this system_modify call once (rail: system-modify-confirm). The grant covers this call only; another call still needs its own approval. Say that the operator was asked and approved, not that the call ran without a prompt.\n",
			),
			text,
		);
	});

	it("names a forwarded worker escalation as the operator answering", async () => {
		const text = await grantedText("escalation:operator");
		ok(text.startsWith(`${OPERATOR_APPROVAL_NOTE_PREFIX} The operator approved this system_modify call once`), text);
		match(text, /through a forwarded worker escalation/u);
	});

	it("attributes an ACP grant to the client and never to this session's operator", async () => {
		const text = await grantedText("acp-client");
		ok(text.startsWith(`${APPROVAL_NOTE_PREFIX} The connected ACP client approved this system_modify call once`), text);
		strictEqual(text.includes("The operator approved"), false, text);
		strictEqual(text.includes(OPERATOR_APPROVAL_NOTE_PREFIX), false, text);
		match(text, /do not claim this session's operator approved it/u);
	});

	it("says a remembered escalation was not a new ask", async () => {
		const text = await grantedText("escalation:remembered");
		ok(text.startsWith(`${APPROVAL_NOTE_PREFIX} This system_modify call ran under a remembered escalation`), text);
		match(text, /not a new ask/u);
		match(text, /Do not say anyone was asked for this call/u);
		strictEqual(text.includes("approved"), false, text);
	});

	it("names an unrecognized source instead of inventing an operator", async () => {
		const text = await grantedText("future-surface");
		ok(text.startsWith(`${APPROVAL_NOTE_PREFIX} This system_modify call was released by 'future-surface'`), text);
		strictEqual(text.includes("The operator approved"), false, text);
	});

	it("scopes every source's grant to this call only", () => {
		for (const requestedBy of ["tool:one_shot", "escalation:operator", "acp-client", "escalation:remembered", "x"]) {
			match(approvalNote({ actionClass: "execute", requestedBy }), /covers this call only/u, requestedBy);
		}
	});

	it("says nothing about approval on a call that never parked", async () => {
		const registry = defaultRegistry();
		registry.onPermissionRequired(() => undefined);
		const settled = await registry.invoke({ tool: ToolNames.Write, args: { path: "data/in.txt", content: "x" } });
		strictEqual(settled.kind, "ok");
		if (settled.kind !== "ok") return;
		const text = settled.result.kind === "ok" ? settled.result.output : settled.result.message;
		strictEqual(text.includes(APPROVAL_NOTE_PREFIX), false, text);
		strictEqual(text.includes(OPERATOR_APPROVAL_NOTE_PREFIX), false, text);
	});

	it("names the rail when the decision carried one, and omits it when it did not", () => {
		const withRail = approvalNote({
			actionClass: "git_destructive",
			requestedBy: "tool:one_shot",
			ruleId: "git-restore-discard-all",
		});
		match(withRail, /once \(rail: git-restore-discard-all\)\./u);
		strictEqual(approvalNote({ actionClass: "system_modify", requestedBy: "acp-client" }).includes("rail:"), false);
		strictEqual(
			approvalNote({ actionClass: "execute", requestedBy: "tool:one_shot", ruleId: "  " }).includes("rail:"),
			false,
		);
	});
});
