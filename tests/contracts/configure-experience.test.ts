import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { orderedSectionControls } from "../../src/cli/configure-controls.js";
import { CONFIGURE_CATEGORY_CHOICES } from "../../src/cli/configure-layout.js";
import { runtimesForCategory } from "../../src/cli/configure-target.js";
import { runDoctorModelChecks } from "../../src/domains/lifecycle/doctor.js";
import { AuthStorage, openAuthStorage } from "../../src/domains/providers/auth/index.js";
import {
	isOrchestratorEligibleRuntime,
	listProviderSupportEntries,
	recordTargetModelSnapshot,
	targetModelSnapshotPath,
} from "../../src/domains/providers/index.js";
import { createRuntimeRegistry, getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { describeHostCapacity } from "../../src/domains/scheduling/local-capacity.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("configure presents complete task-based connection categories without a catch-all escape hatch", () => {
	const registry = createRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const entries = listProviderSupportEntries(registry.list());
	const categories = CONFIGURE_CATEGORY_CHOICES.map((choice) => choice.category);

	assert.deepEqual(categories, ["local-app", "local-server", "subscription", "cloud-api", "external-worker"]);
	assert.ok(
		!CONFIGURE_CATEGORY_CHOICES.some((choice) =>
			/\b(?:all runtimes|advanced|full list)\b/iu.test(`${choice.label} ${choice.summary}`),
		),
	);
	for (const entry of entries) {
		const runtime = registry.get(entry.runtimeId);
		assert.ok(runtime);
		const visible = categories.some((category) =>
			runtimesForCategory(entries, category).some((row) => row.runtimeId === entry.runtimeId),
		);
		assert.equal(visible, true, `${entry.runtimeId} has no understandable category`);
		if (runtime.externalAgentLoop && runtime.auth !== "claude-cli") {
			assert.equal(entry.group, "external-worker", entry.runtimeId);
			assert.ok(!runtimesForCategory(entries, "subscription").some((row) => row.runtimeId === entry.runtimeId));
		}
		if (runtime && isOrchestratorEligibleRuntime(runtime)) {
			assert.ok(
				categories
					.slice(0, 4)
					.some((category) => runtimesForCategory(entries, category).some((row) => row.runtimeId === entry.runtimeId)),
				`${entry.runtimeId} is hidden behind the worker path`,
			);
		}
	}
	assert.ok(runtimesForCategory(entries, "cloud-api").some((entry) => entry.runtimeId === "inception"));
	assert.ok(runtimesForCategory(entries, "cloud-api").some((entry) => entry.runtimeId === "alcf"));
	assert.ok(!runtimesForCategory(entries, "subscription").some((entry) => entry.runtimeId === "alcf"));
	assert.ok(runtimesForCategory(entries, "subscription").some((entry) => entry.runtimeId === "anthropic-max"));
});

test("each settings area exposes its complete catalog in grouped order", () => {
	for (const section of ["chat", "fleet", "context", "safety", "interface", "integrations"] as const) {
		const controls = orderedSectionControls(section);
		assert.ok(controls.length > 0, section);
		const completed = new Set<string>();
		let active = "";
		for (const entry of controls) {
			if (entry.group === active) continue;
			assert.equal(completed.has(entry.group), false, `${section}/${entry.group} is split across the menu`);
			if (active) completed.add(active);
			active = entry.group;
		}
	}
});

test("host capacity copy says what was measured and what was not", () => {
	const detail = describeHostCapacity(
		{ cpus: 12, availableMemoryBytes: 14 * 1024 ** 3, cgroupAvailableBytes: 6 * 1024 ** 3 },
		{ limit: 4, bound: "cgroup" },
	);
	assert.match(detail, /12 usable CPUs/u);
	assert.match(detail, /14\.0 GiB available memory/u);
	assert.match(detail, /6\.0 GiB available to this process/u);
	assert.match(detail, /4 local workers/u);
	assert.match(detail, /GPU\/VRAM and model fit are not checked/u);
});

test("doctor separates passive endpoint reachability from model-list verification", async (t) => {
	const home = await isolateClioEnv("clio-configure-doctor-");
	t.after(() => home.restore());
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url?.endsWith("/v1/models")) response.end(JSON.stringify({ data: [{ id: "live-model" }] }));
		else {
			response.statusCode = 404;
			response.end("{}");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		`version: 2\ntargets:\n  - id: local\n    runtime: openai-compat\n    url: ${url}\n    defaultModel: live-model\nchat:\n  target: local\n  model: live-model\n`,
	);

	const findings = await runDoctorModelChecks();
	const connection = findings.find((finding) => finding.name === "connection local");
	assert.equal(connection?.ok, true);
	assert.match(connection?.detail ?? "", /reachable.*passive metadata only, no generation was attempted/u);
	const model = findings.find((finding) => finding.name === "model local");
	assert.equal(model?.ok, true);
	assert.match(model?.detail ?? "", /live list/u);
});

test("doctor makes unused failures warnings and active credential failures errors even with public metadata", async (t) => {
	const home = await isolateClioEnv("clio-configure-doctor-severity-");
	t.after(() => home.restore());
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const base = registry.get("openai-compat");
	assert.ok(base);
	registry.register({
		...base,
		id: "doctor-public-metadata",
		aliases: [],
		tier: "cloud",
		knownModels: ["m"],
		credentialsEnvVar: "CLIO_DOCTOR_MISSING_KEY",
		probe: async () => ({ ok: true, models: ["m"] }),
	});
	const noProbe = {
		...base,
		id: "doctor-no-passive",
		aliases: [],
		tier: "cloud" as const,
		knownModels: ["m"],
		credentialsEnvVar: "CLIO_DOCTOR_MISSING_KEY",
	};
	delete noProbe.probe;
	delete noProbe.probeModels;
	registry.register(noProbe);
	delete process.env.CLIO_DOCTOR_MISSING_KEY;
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config/settings.yaml"),
		`version: 2
 targets:
   - { id: active-failed, runtime: openai-compat, url: "http://127.0.0.1:1", defaultModel: m }
   - { id: unused-failed, runtime: openai-compat, url: "http://127.0.0.1:1", defaultModel: m }
   - { id: active-key, runtime: doctor-public-metadata, defaultModel: m }
   - { id: unused-key, runtime: doctor-public-metadata, defaultModel: m }
   - { id: active-no-probe, runtime: doctor-no-passive, defaultModel: m }
   - { id: unused-no-probe, runtime: doctor-no-passive, defaultModel: m }
 chat: { target: active-failed, model: m }
 fleet: { default: { target: active-key, model: m } }
 context: { memory: { target: active-no-probe, model: m } }
 `.replace(/^ /gm, ""),
	);
	const findings = await runDoctorModelChecks();
	for (const id of ["active-failed", "active-key", "active-no-probe"]) {
		const finding = findings.find((row) => row.name === `connection ${id}`);
		assert.ok(finding, id);
		assert.equal(finding.ok, false, finding.detail);
	}
	for (const id of ["unused-failed", "unused-key", "unused-no-probe"]) {
		const finding = findings.find((row) => row.name === `connection ${id}`);
		assert.equal(finding?.ok, true);
		assert.equal(finding?.level, "warn");
	}
	assert.match(
		findings.find((row) => row.name === "connection active-key")?.detail ?? "",
		/reachable.*required credential not found/u,
	);
	assert.match(
		findings.find((row) => row.name === "connection active-no-probe")?.detail ?? "",
		/no passive endpoint check.*No generation/u,
	);
});

test("doctor labels static model matches as catalog evidence without endpoint proof", async (t) => {
	const home = await isolateClioEnv("clio-configure-doctor-catalog-");
	t.after(() => home.restore());
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const base = registry.get("openai-compat");
	assert.ok(base);
	const runtime = {
		...base,
		id: "doctor-catalog-only",
		aliases: [],
		auth: "none" as const,
		knownModels: ["catalog-model"],
	};
	delete runtime.probe;
	delete runtime.probeModels;
	registry.register(runtime);
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config/settings.yaml"),
		`version: 2
 targets:
   - { id: catalog, runtime: doctor-catalog-only, defaultModel: catalog-model }
 chat: { target: catalog, model: catalog-model }
 `.replace(/^ /gm, ""),
	);
	const findings = await runDoctorModelChecks();
	assert.match(findings.find((row) => row.name === "connection catalog")?.detail ?? "", /reachability is not verified/u);
	const model = findings.find((row) => row.name === "model catalog");
	assert.equal(model?.level, "info");
	assert.match(model?.detail ?? "", /provider catalog, not this account's live model list/u);
});

test("doctor bounds the whole passive check and aborts unfinished probe work", async (t) => {
	const home = await isolateClioEnv("clio-configure-doctor-timeout-");
	t.after(() => home.restore());
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const base = registry.get("openai-compat");
	assert.ok(base);
	let signal: AbortSignal | undefined;
	registry.register({
		...base,
		id: "doctor-stalled",
		aliases: [],
		auth: "none",
		knownModels: ["m"],
		probe: async (_target, ctx) => {
			signal = ctx.signal;
			return new Promise(() => {});
		},
	});
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config/settings.yaml"),
		`version: 2
 targets:
   - { id: stalled, runtime: doctor-stalled, defaultModel: m }
 chat: { target: stalled, model: m }
 `.replace(/^ /gm, ""),
	);
	const start = Date.now();
	const findings = await runDoctorModelChecks();
	assert.ok(Date.now() - start < 5000, "one probe must not exhaust several sequential HTTP timeouts");
	assert.equal(signal?.aborted, true);
	assert.match(
		findings.find((row) => row.name === "connection stalled")?.detail ?? "",
		/timed out after 2500ms.*no generation/u,
	);
});

test("standard doctor reads stored sign-in tokens without refreshing or changing credentials", async (t) => {
	const home = await isolateClioEnv("clio-configure-doctor-oauth-");
	t.after(() => home.restore());
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const base = registry.get("openai-compat");
	assert.ok(base);
	registry.register({
		...base,
		id: "doctor-oauth",
		aliases: [],
		auth: "oauth",
		knownModels: ["m"],
		probe: async (target, ctx) => {
			assert.equal(Boolean(ctx.authToken), target.id === "valid-signin");
			return { ok: true, models: ["m"] };
		},
	});
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config/settings.yaml"),
		`version: 2
 targets:
   - { id: expired-signin, runtime: doctor-oauth, defaultModel: m, auth: { oauthProfile: expired } }
   - { id: valid-signin, runtime: doctor-oauth, defaultModel: m, auth: { oauthProfile: valid } }
 chat: { target: expired-signin, model: m }
 `.replace(/^ /gm, ""),
	);
	const auth = openAuthStorage();
	for (const [provider, expires] of [
		["expired", 0],
		["valid", Date.now() + 60000],
	] as const)
		auth.set(provider, {
			type: "oauth",
			access: "fixture-access",
			refresh: "fixture-refresh",
			expires,
			updatedAt: new Date().toISOString(),
		});
	const file = join(home.dir, "config/credentials.yaml");
	const before = readFileSync(file, "utf8");
	const resolution = t.mock.method(AuthStorage.prototype, "resolveForTarget", async () => {
		assert.fail("standard doctor must not enter the OAuth refresh path");
	});
	const findings = await runDoctorModelChecks();
	const expired = findings.find((row) => row.name === "connection expired-signin");
	assert.equal(expired?.ok, false);
	assert.match(expired?.detail ?? "", /stored sign-in expired.*auth login/u);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.equal(resolution.mock.callCount(), 0);
	assert.equal(findings.find((row) => row.name === "connection valid-signin")?.ok, true);
});

test("doctor reads earlier model-cache evidence without rewriting it or claiming a live match", async (t) => {
	const home = await isolateClioEnv("clio-configure-doctor-cache-");
	t.after(() => home.restore());
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const target = { id: "cached", runtime: "openai-compat", url: "http://127.0.0.1:1", defaultModel: "cached-model" };
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config/settings.yaml"),
		`version: 2
 targets:
   - { id: cached, runtime: openai-compat, url: "http://127.0.0.1:1", defaultModel: cached-model }
 chat: { target: cached, model: cached-model }
 `.replace(/^ /gm, ""),
	);
	assert.equal(recordTargetModelSnapshot(target, ["cached-model"]), true);
	const file = targetModelSnapshotPath(target.id);
	const before = readFileSync(file, "utf8");
	const findings = await runDoctorModelChecks();
	assert.equal(findings.find((row) => row.name === "connection cached")?.ok, false);
	const model = findings.find((row) => row.name === "model cached");
	assert.equal(model?.level, "info");
	assert.match(model?.detail ?? "", /cached list from .*not verified live now/u);
	assert.equal(readFileSync(file, "utf8"), before);
});
