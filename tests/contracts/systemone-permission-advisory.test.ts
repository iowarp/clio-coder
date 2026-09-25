import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalRequestView } from "../../src/interactive/permission-overlay.js";
import { createPermissionOverlayBody } from "../../src/interactive/permission-overlay.js";

const view: ApprovalRequestView = {
	requestId: "req-1",
	tool: "bash",
	actionClass: "execute",
	axis: { kind: "autonomy", level: "default" },
	origin: { kind: "main" },
	reason: "bash requests execute",
	target: "rm -rf build/",
};

const body = (advisory?: () => string) => createPermissionOverlayBody(view, undefined, undefined, advisory);
const text = (lines: string[]) => lines.join("\n");

describe("permission card advisory line", () => {
	// The card opens the instant the call parks. The advisory is answered over
	// the network after that, so the first frame must render without it.
	it("renders the card before any advisory exists", () => {
		const card = text(body(() => "").render(78));
		ok(card.includes("bash"));
		strictEqual(card.includes("Advisory"), false);
	});

	it("shows the line once an answer lands, without reopening the card", () => {
		let line = "";
		const card = body(() => line);
		strictEqual(text(card.render(78)).includes("Advisory"), false);
		line = "Advisory only, nothing below is gated on it: blast radius reads as broad.";
		ok(text(card.render(78)).includes("blast radius reads as broad"));
	});

	// A Jev outage costs the card one sentence and nothing else. It must never
	// be able to take down the dialog an operator is answering.
	it("renders the card unchanged when the advisory reader throws", () => {
		const thrown = text(
			body(() => {
				throw new Error("ECONNREFUSED");
			}).render(78),
		);
		strictEqual(thrown, text(body().render(78)));
		ok(thrown.includes("bash"));
	});

	// Opt-in by absence: with no site bound there is no reader at all.
	it("is byte-identical to the unbound card when no reader is supplied", () => {
		strictEqual(text(body().render(78)), text(body(() => "").render(78)));
	});

	it("keeps the decision keys and terms on the card beside the advisory", () => {
		const card = text(body(() => "Advisory only, nothing below is gated on it: blast radius reads as local.").render(78));
		ok(card.includes("Allow"));
		ok(card.includes("Deny"));
		ok(card.includes("Stop"));
	});
});
