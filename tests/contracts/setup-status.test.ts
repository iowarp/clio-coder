import assert from "node:assert/strict";
import { test } from "node:test";
import { firstMissing } from "../../src/cli/default-target.js";
import { chatReadinessFinding } from "../../src/cli/doctor.js";
import { assistantError } from "../../src/cli/modes/print.js";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { noteProjectTargets } from "../../src/core/project-target-urls.js";
import {
	describeMissing,
	type Missing,
	missingFromFailedCall,
	missingFromTargetStatus,
	type SetupTargetFacts,
	setupStatus,
} from "../../src/domains/lifecycle/setup-status.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { idleReadinessPresentation } from "../../src/interactive/footer/widgets.js";
import { providerFailureAdvice } from "../../src/interactive/renderers/provider-error.js";
import { nameMissingCredentialRemedy } from "../../src/session-control/chat-loop-messages.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const base: SetupTargetFacts = { id: "t", runtime: "openai", defaultModel: "m", drivesChat: true };

test("setupStatus: the three stages and every missing kind", () => {
	const kinds = (facts: Partial<SetupTargetFacts>, withModel = true) => {
		const { defaultModel: _model, ...modelless } = base;
		const status = setupStatus({ chat: { target: "t" }, target: { ...(withModel ? base : modelless), ...facts } });
		return status.stage === "needs" ? status.missing.map((item) => item.kind) : status.stage;
	};
	assert.equal(setupStatus({ chat: {} }).stage, "choose");
	assert.equal(kinds({ credential: { available: true, provider: "openai" }, answered: true }), "ready");
	const needs = setupStatus({
		chat: { target: "t" },
		target: { ...base, credential: { available: false, provider: "openai" } },
	});
	assert.equal(needs.stage, "needs");
	assert.deepEqual(
		needs.stage === "needs" && describeMissing(needs.missing[0] as Missing).command,
		"clio-coder auth login openai",
	);
	assert.deepEqual(
		kinds({
			url: "http://127.0.0.1:9",
			credential: { available: false, provider: "x", envVariable: "X_KEY" },
			probe: { ok: false, detail: "refused" },
			modelOffered: false,
		}),
		["env", "unreachable", "model"],
	);
	assert.deepEqual(kinds({ answered: false }, false), ["model"]);
	assert.deepEqual(kinds({ answered: false }), ["untested"]);
	assert.deepEqual(kinds({ drivesChat: false }, false), ["runtime"]);
});

test("every surface prints the setup status's sentence for a missing credential and an unreachable endpoint", async (t) => {
	const home = await isolateClioEnv("clio-setup-status-");
	t.after(() => home.restore());
	delete process.env.OPENAI_API_KEY;
	initializeClioHome();
	updateSettings((settings) => {
		settings.targets = [{ id: "oa", runtime: "openai", defaultModel: "gpt-x" }];
		settings.chat.target = "oa";
		settings.chat.model = "gpt-x";
	});
	const credential = describeMissing({ kind: "credential", target: "oa", provider: "openai" }).sentence;
	assert.equal(credential, "openai has no key or sign-in stored. Run: clio-coder auth login openai");
	const status = (available: boolean, health: string) => ({
		target: { id: "oa", url: "http://127.0.0.1:9" },
		available,
		reason: available ? "ok" : "missing auth (OPENAI_API_KEY or store:openai)",
		health: { status: health, lastError: available ? "connection failed" : null },
	});
	const banner = (missing: Missing | null, available: boolean) =>
		idleReadinessPresentation(
			{
				targetId: "oa",
				available,
				reason: status(available, "down").reason,
				health: available ? "down" : "unknown",
				lastStop: null,
				...(missing ? { missing } : {}),
			},
			400,
		).label;
	const failed = (text: string) =>
		({ role: "assistant", stopReason: "error", errorMessage: text }) as unknown as AgentMessage;

	const credentialMessage = failed("No API key for provider: openai");
	nameMissingCredentialRemedy(credentialMessage);
	const credentialSurfaces = {
		banner: banner(missingFromTargetStatus(status(false, "unknown")), false),
		failedPrompt: providerFailureAdvice(
			{ targetId: "oa", stage: "auth", errorClass: "missing_credential" },
			"No API key for provider: openai",
		),
		run: assistantError(credentialMessage),
		doctor: chatReadinessFinding(false, []).detail,
	};
	for (const [surface, text] of Object.entries(credentialSurfaces))
		assert.ok(text?.includes(credential), `${surface}: ${text}`);
	// Inside the TUI the same line also names the way in from the session.
	for (const text of [credentialSurfaces.banner, credentialSurfaces.failedPrompt])
		assert.ok(text.includes(`${credential} (or press Enter on /config)`), text);
	for (const text of [credentialSurfaces.run, credentialSurfaces.doctor])
		assert.ok(!text?.includes("/config"), text ?? "");

	updateSettings((settings) => {
		settings.targets = [
			{
				id: "oa",
				runtime: "openai",
				url: "http://127.0.0.1:9",
				defaultModel: "gpt-x",
				auth: { apiKeyEnvVar: "OPENAI_API_KEY" },
			},
		];
	});
	process.env.OPENAI_API_KEY = "fake";
	const route = {
		targetId: "oa",
		url: "http://127.0.0.1:9",
		stage: "transport",
		errorClass: "network_error",
		partialReply: false,
	};
	const unreachable = describeMissing(missingFromFailedCall(route) as Missing).sentence;
	assert.equal(
		unreachable,
		"oa at http://127.0.0.1:9 did not answer (connection failed). Start the server, or change the address with /config.",
	);
	const unreachableSurfaces = {
		banner: banner(missingFromTargetStatus(status(true, "down")), true),
		failedPrompt: providerFailureAdvice(route),
		run: assistantError({ ...failed("Connection error."), failureRoute: route } as unknown as AgentMessage),
		doctor: chatReadinessFinding(false, [
			{
				ok: false,
				name: "connection oa",
				detail: "oa at http://127.0.0.1:9 was not verified: connection failed. Check it",
			},
		]).detail,
	};
	for (const [surface, text] of Object.entries(unreachableSurfaces))
		assert.ok(text?.includes(unreachable), `${surface}: ${text}`);
});

test("a chat route at an address a project chose says to define it in user settings, not to sign in", async (t) => {
	const home = await isolateClioEnv("clio-setup-status-");
	t.after(() => home.restore());
	initializeClioHome();
	const url = "https://llm.lab.example.org/v1";
	updateSettings((settings) => {
		settings.targets = [{ id: "lab-gateway", runtime: "openai", url, defaultModel: "gpt-x" }];
		settings.chat.target = "lab-gateway";
		settings.chat.model = "gpt-x";
	});
	noteProjectTargets([{ id: "lab-gateway", url }]);
	// A key in the shell does not change it: Clio sends none to an address a project chose.
	process.env.OPENAI_API_KEY = "sk-test";
	const sentence = `lab-gateway points at ${url}, an address this project chose, so Clio sends it none of your keys. To use it, define lab-gateway in your user settings with its key in OPENAI_API_KEY.`;
	const missing = firstMissing(readSettings());
	assert.ok(missing);
	assert.deepEqual(describeMissing(missing), { sentence });
	assert.equal(describeMissing(missing, { inSession: true }).sentence, sentence);
	assert.equal(chatReadinessFinding(false, []).detail, `target 'lab-gateway', model 'gpt-x'; ${sentence}`);
	const pure = setupStatus({
		chat: { target: "t" },
		target: { ...base, credential: { available: false, provider: "openai", envVariable: "LAB_KEY", projectUrl: url } },
	});
	assert.deepEqual(pure.stage === "needs" && pure.missing, [
		{ kind: "credential", target: "t", provider: "openai", projectUrl: url, variable: "LAB_KEY" },
	]);
});
