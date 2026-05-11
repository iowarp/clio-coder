import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAutoApproveForDispatch } from "../../src/domains/dispatch/extension.js";

describe("dispatch supervised autoApprove derivation", () => {
	it("headless run with no autoApprove gets autoApprove=deny and a runtimeLimitations note", () => {
		const result = deriveAutoApproveForDispatch({}, ["external runtime"]);
		strictEqual(result.supervised, false);
		strictEqual(result.autoApprove, "deny");
		deepStrictEqual(result.runtimeLimitations.slice(0, 1), ["external runtime"]);
		ok(result.runtimeLimitations.some((entry) => entry.includes("headless ask auto-denied")));
	});

	it("interactive run with no autoApprove leaves autoApprove unset for live IPC", () => {
		const result = deriveAutoApproveForDispatch({ supervised: true }, []);
		strictEqual(result.supervised, true);
		strictEqual(result.autoApprove, undefined);
		deepStrictEqual(result.runtimeLimitations, []);
	});

	it("--auto-approve allow always wins regardless of supervised", () => {
		const result = deriveAutoApproveForDispatch({ supervised: false, autoApprove: "allow" }, []);
		strictEqual(result.supervised, false);
		strictEqual(result.autoApprove, "allow");
		deepStrictEqual(result.runtimeLimitations, []);
	});
});
