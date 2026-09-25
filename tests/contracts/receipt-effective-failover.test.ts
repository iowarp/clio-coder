import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { RECEIPT_INTEGRITY_FIELD_COVERAGE } from "../../src/domains/dispatch/receipt-integrity.js";
import { effectiveFailoverMode } from "../../src/domains/dispatch/recovery-candidates.js";
import { defaultRoutingIntent } from "../../src/domains/dispatch/routing-intent.js";

// BT-010. `DispatchFailoverMode` has three values and `RoutingFailover` has
// two, so an unpinned run whose retries were governed by `automatic` sealed a
// receipt reading `routingIntent.failover: "none"`. A sealed route and a
// drifting one were indistinguishable in evidence. The receipt now records the
// mode that actually governed the run, beside the intent it was asked for.
// Route selection is unchanged: this is evidence only.

test("an unpinned request is governed by automatic failover", () => {
	strictEqual(effectiveFailoverMode({}), "automatic");
});

test("a target or node pin seals the tuple with none", () => {
	strictEqual(effectiveFailoverMode({ target: "mini" }), "none");
	strictEqual(effectiveFailoverMode({ node: "blade" }), "none");
	strictEqual(effectiveFailoverMode({ target: "mini", node: "blade" }), "none");
});

test("an explicit request failover wins over the pin default", () => {
	strictEqual(effectiveFailoverMode({ failover: "approved" }), "approved");
	strictEqual(effectiveFailoverMode({ failover: "none" }), "none");
	strictEqual(effectiveFailoverMode({ failover: "approved", target: "mini" }), "approved");
});

// The contradiction BT-010 reported, stated directly: the intent a request
// carries and the mode that governs its retries are different questions, and
// the receipt must be able to answer both.
test("the recorded intent and the governing mode can legitimately differ", () => {
	const intent = defaultRoutingIntent({});
	strictEqual(intent.failover, "none");
	strictEqual(effectiveFailoverMode({}), "automatic");
});

test("the receipt field is covered by integrity", () => {
	ok(Object.hasOwn(RECEIPT_INTEGRITY_FIELD_COVERAGE, "effectiveFailover"));
});
