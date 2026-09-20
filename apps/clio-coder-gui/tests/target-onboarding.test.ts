import assert from "node:assert/strict";
import { test } from "node:test";
import {
	authGuidance,
	type Draft,
	draftProblems,
	type Runtime,
	suggestId,
	toRequest,
} from "../client/pages/target-onboarding-model.js";

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
	id: "openai-compat",
	label: "Generic OpenAI-compatible",
	group: "Local HTTP",
	summary: "Any OpenAI-compatible endpoint",
	defaultModel: null,
	modelHints: [],
	modelRequired: false,
	supportsCustomUrl: true,
	auth: "key-optional",
	targetCount: 0,
	...over,
});
const draft = (over: Partial<Draft> = {}): Draft => ({
	runtime: "openai-compat",
	id: "local",
	url: "",
	model: "",
	apiKeyEnv: "",
	useForChat: false,
	...over,
});

test("every authentication state names a terminal step or none, and never asks for a key", () => {
	for (const auth of ["none", "login", "connected", "credential", "needs-key", "key-optional", "other"] as const) {
		const guidance = authGuidance(runtime({ auth, id: "anthropic" }));
		assert.ok(guidance.text.length > 0, auth);
		assert.doesNotMatch(guidance.text, /paste|enter your key|type your key/i, auth);
	}
	assert.equal(authGuidance(runtime({ auth: "connected" })).tone, "ready");
	assert.equal(authGuidance(runtime({ auth: "login", id: "openai-codex" })).tone, "action");
	assert.match(authGuidance(runtime({ auth: "login", id: "openai-codex" })).text, /clio-coder auth login openai-codex/);
	assert.match(authGuidance(runtime({ auth: "needs-key" })).text, /no key field on purpose/);
});

test("a suggested id avoids the ones already configured", () => {
	assert.equal(suggestId(runtime(), []), "openai-compat");
	assert.equal(suggestId(runtime(), ["openai-compat"]), "openai-compat-2");
	assert.equal(suggestId(runtime(), ["openai-compat", "openai-compat-2"]), "openai-compat-3");
});

test("the page names field problems the contract would reject, and a catalog runtime needs a model", () => {
	assert.deepEqual(draftProblems(draft(), undefined, []), ["Choose a runtime."]);
	assert.deepEqual(draftProblems(draft(), runtime(), []), []);
	assert.match(draftProblems(draft({ id: "--force" }), runtime(), [])[0] ?? "", /connection id/);
	assert.match(draftProblems(draft(), runtime(), ["local"])[0] ?? "", /already exists/);
	assert.match(draftProblems(draft({ url: "file:///etc/passwd" }), runtime(), [])[0] ?? "", /http:\/\//);
	assert.match(draftProblems(draft({ apiKeyEnv: "BAD NAME" }), runtime(), [])[0] ?? "", /environment variable/);
	assert.match(draftProblems(draft(), runtime({ modelRequired: true }), [])[0] ?? "", /choose a model/);
	assert.deepEqual(draftProblems(draft({ model: "claude" }), runtime({ modelRequired: true }), []), []);
});

test("blank optional fields are omitted, and a URL is dropped for a runtime that cannot take one", () => {
	assert.deepEqual(toRequest(draft(), runtime()), { id: "local", runtime: "openai-compat" });
	assert.deepEqual(
		toRequest(draft({ url: " http://127.0.0.1:8080 ", model: " m ", apiKeyEnv: "KEY", useForChat: true }), runtime()),
		{
			id: "local",
			runtime: "openai-compat",
			url: "http://127.0.0.1:8080",
			model: "m",
			apiKeyEnv: "KEY",
			useForChat: true,
		},
	);
	assert.deepEqual(toRequest(draft({ url: "http://x" }), runtime({ supportsCustomUrl: false })), {
		id: "local",
		runtime: "openai-compat",
	});
});
