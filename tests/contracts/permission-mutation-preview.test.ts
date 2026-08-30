/**
 * A parked `write` card said `content=<string 482 bytes>` and a parked `edit`
 * card said `edits=<array 3 items>`, and there was no key, no expansion, and no
 * overlay that would show the operator what those bytes were. Approving a
 * mutation meant approving something you had never read, and during the WTF-P
 * UAT the only way to read it was the external session ledger (issue #254).
 *
 * These are the two halves of the fix. The overlay can show the complete
 * proposed content and the complete effective diff, bound by a digest to the
 * exact arguments the decision resumes. And the mutation text goes nowhere
 * else: not onto the approval view, not into the transcript row, not into the
 * parked notice.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { approvalParkedNotice } from "../../src/interactive/bus-notices.js";
import {
	callArgumentsDigest,
	createMutationInspector,
	MUTATION_PREVIEW_MAX_CHARS,
	MUTATION_PREVIEW_VISIBLE_ROWS,
	mutationFacts,
} from "../../src/interactive/mutation-preview.js";
import { routePermissionOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	permissionOverlayHint,
	permissionOverlayLines,
} from "../../src/interactive/permission-overlay.js";
import { renderToolAwaitingApproval } from "../../src/interactive/renderers/tool-execution.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const SECRET = "AKIAIOSFODNN7EXAMPLESECRET";
const WRITE_CONTENT = ["# proposal", "", `token = "${SECRET}"`, "", "body line one", "body line two"].join("\n");

function writeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { path: "proposal.md", content: WRITE_CONTENT, ...overrides };
}

function approvalView(tool: string, args: Record<string, unknown>): ApprovalRequestView {
	const facts = mutationFacts(tool, args);
	return {
		requestId: "req-1",
		tool,
		actionClass: "write",
		axis: { kind: "autonomy", level: "suggest" },
		origin: { kind: "main" },
		reason: "approval required",
		target: typeof args.path === "string" ? args.path : "",
		...(facts !== null ? { mutation: facts } : {}),
	};
}

function bodyLines(tool: string, args: Record<string, unknown>, width: number, readFile?: (path: string) => string) {
	const view = approvalView(tool, args);
	const facts = mutationFacts(tool, args);
	ok(facts !== null, "the fixture is a describable mutation");
	const body = createPermissionOverlayBody(
		view,
		createMutationInspector(tool, args, facts, ...(readFile ? [{ readFile }] : [])),
	);
	return { view, body, collapsed: body.render(width) };
}

/** A temp file the edit fixtures diff against, written once per call. */
function fixtureFile(name: string, content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-mutation-preview-"));
	const path = join(dir, name);
	writeFileSync(path, content, "utf8");
	return path;
}

describe("contracts/parked mutation inspection", () => {
	it("exposes the complete proposed content of a parked write to the overlay", () => {
		const args = writeArgs();
		const { body } = bodyLines("write", args, 80);

		strictEqual(body.canInspect(), true, "a parked write has something local to read");
		strictEqual(body.isInspecting(), false, "and it stays collapsed until the operator asks");
		body.toggleInspect();
		const opened = body.render(80).join("\n");

		for (const line of WRITE_CONTENT.split("\n")) {
			if (line.length === 0) continue;
			ok(opened.includes(line), `every proposed line is readable: missing ${JSON.stringify(line)}`);
		}
		ok(opened.includes("Proposed content for proposal.md"), opened);
	});

	/**
	 * The edit card carried `edits=<array N items>`, and printing that array back
	 * would still not say what the file ends up as. The preview applies the edits
	 * to the bytes on disk and shows the diff the call would actually produce.
	 */
	it("computes a parked edit's effective diff from the file on disk, not from the edit array", () => {
		const path = fixtureFile("target.ts", ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n"));
		const args = {
			path,
			edits: [
				{ oldText: "const a = 1;", newText: "const a = 41;" },
				{ oldText: "const c = 3;", newText: "const c = 43;" },
			],
		};
		const { body } = bodyLines("edit", args, 100);
		body.toggleInspect();
		const opened = body.render(100).join("\n");

		ok(opened.includes("Effective diff for"), opened);
		ok(opened.includes("-1 const a = 1;"), `the replaced line is shown as removed: ${opened}`);
		ok(opened.includes("+1 const a = 41;"), `the replacement is shown as added: ${opened}`);
		ok(opened.includes("+3 const c = 43;"), `every replacement appears, not just the first: ${opened}`);
		ok(!opened.includes("oldText"), `the raw edit array is not what the operator reads: ${opened}`);
	});

	it("says what it could not compute rather than showing nothing", () => {
		const args = { path: "/nonexistent/clio/target.ts", edits: [{ oldText: "a", newText: "b" }] };
		const { body } = bodyLines("edit", args, 100, () => {
			throw new Error("ENOENT: no such file or directory");
		});
		body.toggleInspect();
		const opened = body.render(100).join("\n");

		ok(opened.includes("the file could not be read"), opened);
		ok(opened.includes("- a") && opened.includes("+ b"), `the requested replacement is still readable: ${opened}`);
	});

	it("refuses the preview when the arguments no longer digest to the decision's identity", () => {
		const args = writeArgs();
		const facts = mutationFacts("write", args);
		ok(facts !== null);
		// The same call shape, a different payload: the inspector is bound to the
		// digest taken when the card opened, so it will not render these bytes.
		const inspector = createMutationInspector("write", { ...args, content: "something else entirely" }, facts);
		const preview = inspector();

		strictEqual(preview.heading, "Preview unavailable");
		ok(preview.body.join("\n").includes(facts.digest), preview.body.join("\n"));
		ok(!preview.body.join("\n").includes("something else entirely"), "and it shows none of the changed payload");
	});

	it("binds the digest to the arguments and not to their key order", () => {
		const a = callArgumentsDigest({ path: "x.md", content: "hello" });
		const b = callArgumentsDigest({ content: "hello", path: "x.md" });
		const c = callArgumentsDigest({ path: "x.md", content: "hellO" });
		strictEqual(a, b, "the same call digests the same way whatever order the keys arrive in");
		ok(a !== c, "and a different payload is a different call");
	});

	it("keeps path, byte count, and digest on the collapsed card at 40, 80, and 120 columns", () => {
		const args = writeArgs();
		const view = approvalView("write", args);
		const facts = view.mutation;
		ok(facts !== undefined);
		for (const width of [40, 80, 120]) {
			const lines = permissionOverlayLines(view, width);
			const joined = lines.join("\n");
			ok(joined.includes("proposal.md"), `${width}: the path stays on the card: ${joined}`);
			ok(joined.includes(`${facts.bytes} B`), `${width}: the byte count stays on the card: ${joined}`);
			ok(joined.includes(facts.digest), `${width}: the digest stays on the card: ${joined}`);
			ok(joined.includes("Press v"), `${width}: the inspect key is named: ${joined}`);
			for (const line of lines) {
				ok(line.length <= width, `${width}: no line overflows the frame: ${JSON.stringify(line)}`);
			}
		}
	});

	it("names the inspect key on the card's hint line only while there is something to inspect", () => {
		ok(permissionOverlayHint(80, false, "none").includes("[Esc] deny"));
		ok(!permissionOverlayHint(80, false, "none").includes("[v]"), permissionOverlayHint(80, false, "none"));
		ok(permissionOverlayHint(80, false, "closed").includes("[v] inspect mutation"), "the closed card offers it");
		ok(permissionOverlayHint(80, false, "open").includes("[v] hide"), "the open card takes it back");
		ok(permissionOverlayHint(80, false, "open").includes("[↑↓] scroll"), "and says how to move through it");
		// At 40 columns the four entries do not fit. The keys that answer the call
		// are what survive; the one that reads it is elided and keeps working,
		// which is the trade the hint's own classification encodes.
		const narrow = permissionOverlayHint(40, false, "closed");
		for (const fragment of ["[Enter] allow", "[s] stop", "[Esc] deny"]) {
			ok(narrow.includes(fragment), `40 columns keeps ${fragment}: ${narrow}`);
		}
		ok(!narrow.includes("[v]"), `and gives up the inspect key rather than an answer key: ${narrow}`);
	});

	/**
	 * Esc means deny on this surface at every moment, including while the
	 * mutation is on screen; `v` is what puts the mutation away. Enter and `s`
	 * keep answering the call throughout, so an operator who has read enough does
	 * not have to close anything first.
	 */
	it("keeps every answer key live while the mutation is open, and toggles with the same key", () => {
		const args = writeArgs();
		const { body } = bodyLines("write", args, 80);
		const events: string[] = [];
		const deps = {
			cancelPermission: () => events.push("deny"),
			confirmPermission: () => events.push("allow"),
			stopTurnFromPermission: () => events.push("stop"),
			canInspectMutation: () => body.canInspect(),
			isInspectingMutation: () => body.isInspecting(),
			toggleMutationInspection: () => body.toggleInspect(),
			scrollMutationInspection: (delta: number) => body.scrollInspect(delta),
		};

		strictEqual(routePermissionOverlayKey("v", deps), true);
		strictEqual(body.isInspecting(), true, "v opens it");
		body.render(80);
		strictEqual(routePermissionOverlayKey("s", deps), true);
		strictEqual(routePermissionOverlayKey(`${ESC}`, deps), true);
		strictEqual(routePermissionOverlayKey("\r", deps), true);
		strictEqual(events.join(","), "stop,deny,allow", "stop, deny, and allow all still answer the call");
		strictEqual(routePermissionOverlayKey("v", deps), true);
		strictEqual(body.isInspecting(), false, "and v puts it away again");
	});

	it("leaves the inspect key inert on a card with nothing local to read", () => {
		const view: ApprovalRequestView = {
			requestId: "req-bash",
			tool: "bash",
			actionClass: "execute",
			axis: { kind: "autonomy", level: "suggest" },
			origin: { kind: "main" },
			reason: "approval required",
		};
		const body = createPermissionOverlayBody(view);
		strictEqual(body.canInspect(), false);
		let toggled = 0;
		const consumed = routePermissionOverlayKey("v", {
			cancelPermission: () => {},
			confirmPermission: () => {},
			stopTurnFromPermission: () => {},
			canInspectMutation: () => body.canInspect(),
			toggleMutationInspection: () => {
				toggled += 1;
			},
		});
		strictEqual(consumed, false, "the key falls through rather than pretending to do something");
		strictEqual(toggled, 0);
	});

	it("scrolls a mutation taller than the window and marks where the window sits", () => {
		const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
		const { body } = bodyLines("write", writeArgs({ content }), 80);
		body.toggleInspect();
		const first = body.render(80).join("\n");
		ok(first.includes(`(1-${MUTATION_PREVIEW_VISIBLE_ROWS} of 60 lines)`), first);
		ok(first.includes("line 1"), first);
		ok(!first.includes("line 60"), "the window is a window");

		body.scrollInspect(1000);
		const last = body.render(80).join("\n");
		ok(last.includes("line 60"), `scrolling reaches the end: ${last}`);
		ok(last.includes("of 60 lines)"), last);
	});

	it("neutralizes terminal control sequences before they reach the approving UI", () => {
		const hostile = `harmless\n${ESC}]0;stolen title${String.fromCharCode(7)}${ESC}[31mred${ESC}[0m\nafter`;
		const { body } = bodyLines("write", writeArgs({ content: hostile }), 80);
		body.toggleInspect();
		const opened = body.render(80);
		const joined = opened.join("\n");

		ok(!joined.includes(ESC), "no escape byte survives into the overlay body");
		ok(!joined.includes("stolen title"), `and the OSC payload goes with it: ${joined}`);
		ok(joined.includes("red"), "the printable text the sequence wrapped is still shown");
		ok(joined.includes("control characters shown as ·"), `the neutralization is stated: ${joined}`);
	});

	it("marks the cut when the proposed content is larger than the preview carries", () => {
		const oversized = "x".repeat(MUTATION_PREVIEW_MAX_CHARS + 500);
		const { body } = bodyLines("write", writeArgs({ content: oversized }), 80);
		body.toggleInspect();
		body.render(80);
		body.scrollInspect(1_000_000);
		const joined = body.render(80).join("\n");
		ok(joined.includes("500 more characters not shown"), `the withheld tail is named: ${joined.slice(-400)}`);
	});

	/**
	 * The overlay is a local surface. Every other place the parked call is
	 * described is one the operator does not control the audience of, so the
	 * bytes must not reach any of them.
	 */
	it("keeps the mutation text out of the approval view, the transcript row, and the parked notice", () => {
		const args = writeArgs();
		const view = approvalView("write", args);

		const serialized = JSON.stringify(view);
		ok(!serialized.includes(SECRET), `the view the transcript receives carries no payload: ${serialized}`);
		ok(!serialized.includes("body line one"), serialized);
		ok(view.mutation !== undefined && serialized.includes(view.mutation.digest), "only facts travel");

		const row = renderToolAwaitingApproval({ toolCallId: "call-1", toolName: "write", args } as never, 100, view).map(
			stripAnsi,
		);
		const joinedRow = row.join("\n");
		ok(!joinedRow.includes(SECRET), `the transcript row carries no payload: ${joinedRow}`);
		ok(!joinedRow.includes("body line one"), joinedRow);
		ok(joinedRow.includes(view.mutation?.digest ?? "-"), `it carries the digest instead: ${joinedRow}`);
		ok(joinedRow.includes("482 B") || /\d+ B/.test(joinedRow), `and the byte count: ${joinedRow}`);

		const decision = {
			kind: "ask",
			classification: { actionClass: "write" },
			rejection: { short: "approval required", detail: "approval required" },
		} as SafetyDecision;
		const notice = approvalParkedNotice("write", decision, "suggest");
		ok(!notice.text.includes(SECRET), `the parked notice carries no payload: ${notice.text}`);
		ok(!notice.text.includes("body line one"), notice.text);
	});

	/**
	 * A worker escalation crosses the NDJSON stdout seam carrying a sanitized
	 * one-line target and nothing else. The honest answer is to say so rather
	 * than to offer a key that would show a preview of arguments this process
	 * does not have.
	 */
	it("tells a worker card's operator that there is nothing to inspect locally", () => {
		const view: ApprovalRequestView = {
			requestId: "req-worker",
			tool: "write",
			actionClass: "write",
			axis: { kind: "autonomy", level: "suggest" },
			origin: { kind: "worker", agentId: "scout", runId: "run-7" },
			reason: "approval required",
			target: "docs/plan.md · content=<string 900 bytes>",
		};
		const joined = permissionOverlayLines(view, 80).join("\n");
		ok(joined.includes("No local preview"), joined);
		ok(joined.includes("stay inside the worker"), joined);
		ok(!joined.includes("Press v"), `and it does not advertise a key it cannot honor: ${joined}`);
		strictEqual(createPermissionOverlayBody(view).canInspect(), false);
	});

	it("describes only the tools whose parked call mutates a file", () => {
		strictEqual(mutationFacts("bash", { command: "rm -rf /" }), null);
		strictEqual(mutationFacts("write", { path: "a.md" }), null, "a write with no content is not describable");
		strictEqual(mutationFacts("edit", { path: "a.md", edits: [] }), null, "and neither is an empty edit list");
		const facts = mutationFacts("edit", {
			path: "a.md",
			edits: [
				{ oldText: "a", newText: "bb" },
				{ oldText: "c", newText: "ddd" },
			],
		});
		strictEqual(facts?.replacements, 2);
		strictEqual(facts?.bytes, 5);
	});

	it("still describes the parked call for an operator who never opens the mutation", () => {
		const call = { tool: "write", args: writeArgs() } as ClassifierCall;
		const view = approvalView(call.tool, call.args as Record<string, unknown>);
		const collapsed = permissionOverlayLines(view, 80).join("\n");
		ok(collapsed.includes("Tool: write"), collapsed);
		ok(!collapsed.includes(SECRET), `the collapsed card is still bounded: ${collapsed}`);
	});
});
