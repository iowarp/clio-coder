/**
 * Clio answers a peer's session/request_permission for one call at a time.
 * `allow_always` would turn that one approval into a standing grant inside
 * the peer, which Clio's policy never gave, so it is never selected. When a
 * peer offers no `allow_once`, the approved call is answered with a reject
 * option and the delegation tool log says why.
 */
import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type AcpMediatorPermissionResolvedEvent, AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import type { AcpPermissionOption } from "../../src/engine/acp/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

const root = mkdtempSync(join(tmpdir(), "clio-coder-acp-permission-options-"));

function option(kind: AcpPermissionOption["kind"]): AcpPermissionOption {
	return { optionId: `opt-${kind}`, kind, name: kind };
}

function mediator(resolved: AcpMediatorPermissionResolvedEvent[] = []) {
	return new AcpToolMediator({
		safety: createWorkerSafety({ cwd: root }),
		cwd: root,
		toolGovernance: "clio-coder-policy",
		onPermissionResolved: (event) => resolved.push(event),
	});
}

/** A read inside the workspace, which Clio's policy approves. */
const approvedRead = { toolCallId: "read-1", kind: "read", rawInput: { path: "notes.txt" } };
/** A read outside the workspace, which default autonomy denies without an operator. */
const deniedRead = { toolCallId: "read-2", kind: "read", rawInput: { path: "/etc/hostname" } };

describe("ACP permission option selection", () => {
	after(() => rmSync(root, { recursive: true, force: true }));

	it("selects allow_once for an approved call even when allow_always is listed first", async () => {
		const peer = mediator();
		const response = await peer.handle({
			toolCall: approvedRead,
			options: [option("allow_always"), option("allow_once"), option("reject_once")],
		});
		deepStrictEqual(response, { outcome: { outcome: "selected", optionId: "opt-allow_once" } });
		strictEqual(peer.snapshot().toolCallLog[0]?.decision, "approved");
		strictEqual(peer.snapshot().toolCallsApproved, 1);
	});

	it("rejects an approved call when the peer offers no allow_once, and records why", async () => {
		for (const [options, rejectKind] of [
			[[option("allow_always"), option("reject_once"), option("reject_always")], "reject_once"],
			[[option("allow_always"), option("reject_always")], "reject_always"],
		] as const) {
			const resolved: AcpMediatorPermissionResolvedEvent[] = [];
			const peer = mediator(resolved);
			const response = await peer.handle({ toolCall: approvedRead, options: [...options] });
			deepStrictEqual(response, { outcome: { outcome: "selected", optionId: `opt-${rejectKind}` } });
			const snapshot = peer.snapshot();
			strictEqual(snapshot.toolCallsApproved, 0);
			strictEqual(snapshot.toolCallsDenied, 1);
			const entry = snapshot.toolCallLog[0];
			strictEqual(entry?.decision, "denied");
			match(entry?.reason ?? "", /no allow_once option/u);
			match(entry?.reason ?? "", /never selects allow_always/u);
			strictEqual(resolved.length, 1, "the rejection is reported on the permission event stream");
			match(resolved[0]?.reason ?? "", /no allow_once option/u);
		}
	});

	it("cancels an approved call when the peer offers neither allow_once nor a reject option", async () => {
		const peer = mediator();
		const response = await peer.handle({ toolCall: approvedRead, options: [option("allow_always")] });
		deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
		strictEqual(peer.snapshot().toolCallLog[0]?.decision, "denied");
	});

	it("never falls back to an allow option for a denied call", async () => {
		const peer = mediator();
		const response = await peer.handle({
			toolCall: deniedRead,
			options: [option("allow_once"), option("allow_always"), option("reject_once")],
		});
		deepStrictEqual(response, { outcome: { outcome: "selected", optionId: "opt-reject_once" } });
		const noReject = await peer.handle({ toolCall: deniedRead, options: [option("allow_once"), option("allow_always")] });
		deepStrictEqual(noReject, { outcome: { outcome: "cancelled" } });
	});
});
