import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetBannerView, formatUsd, raiseSettingWrite, settingsHref } from "../client/chat/budget-model.js";

const stop = {
	level: "at" as const,
	currentUsd: 5.0008,
	ceilingUsd: 5,
	contextTokens: 12345,
	raiseToUsd: 5.5009,
	setting: "safety.limits.sessionCostUsd",
};

test("the ceiling banner names the spend, the ceiling, the parked request and the one-click raise", () => {
	const view = budgetBannerView(stop, { raisedTo: null, error: null });
	assert.equal(view.tone, "warn");
	assert.match(view.title, /paused at the session cost ceiling/u);
	assert.match(view.detail, /\$5\.00 of \$5\.00/u);
	assert.match(view.detail, /12,345 context tokens/u);
	assert.match(view.detail, /safety\.limits\.sessionCostUsd/u);
	assert.deepEqual(view.raise, {
		label: "Raise ceiling to $5.5009",
		path: "safety.limits.sessionCostUsd",
		value: "5.5009",
	});
	assert.deepEqual(raiseSettingWrite(stop), { path: "safety.limits.sessionCostUsd", value: "5.5009" });
	assert.equal(settingsHref(stop), "/settings/advanced?q=sessionCostUsd");
	const over = budgetBannerView({ ...stop, level: "over", contextTokens: null }, { raisedTo: null, error: null });
	assert.match(over.title, /above the session cost ceiling/u);
	assert.doesNotMatch(over.detail, /context tokens/u);
});

test("after the raise is written the banner says so, and a refused write keeps the raise on offer", () => {
	const raised = budgetBannerView(stop, { raisedTo: "5.5009", error: null });
	assert.equal(raised.tone, "quiet");
	assert.match(raised.title, /raised to \$5\.5009/u);
	assert.equal(raised.raise, null);
	const refused = budgetBannerView(stop, { raisedTo: null, error: "Set by the project layer." });
	assert.equal(refused.tone, "warn");
	assert.match(refused.detail, /not saved: Set by the project layer\./u);
	assert.ok(refused.raise);
});

test("sub-cent ceilings keep enough digits to tell spend and ceiling apart, like the engine's notice", () => {
	assert.equal(formatUsd(0.0012, 0.001), "$0.0012");
	assert.equal(formatUsd(5, 5), "$5.00");
});
