import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	ClioCliRoutingInspector,
	projectRoutingBindings,
	projectRoutingModels,
	projectRoutingProfiles,
} from "../clio-routing-inspector.ts";

const FIXTURE = new URL("./routing-inspect-child-fixture.ts", import.meta.url).pathname;

function fixtureInspector(scenario: "valid" | "partial" = "valid"): ClioCliRoutingInspector {
	return new ClioCliRoutingInspector({
		executable: Deno.execPath(),
		prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, `--scenario=${scenario}`, "--"],
		now: () => Date.parse("2026-08-29T15:00:00.000Z"),
	});
}

Deno.test("routing projections preserve typed model and binding facts while dropping provider details", () => {
	const models = projectRoutingModels([{
		targetId: "lab",
		runtimeId: "lmstudio",
		modelId: "qwen3.8-27b",
		caps: "CTR----",
		contextWindow: 262_144,
		maxTokens: 32_768,
		reasoning: true,
		state: "loaded",
		baseUrl: "https://operator:secret@example.invalid/v1",
	}, {
		targetId: "empty",
		runtimeId: "openai-compatible",
		modelId: "(no models)",
		caps: "C------",
		contextWindow: 0,
		maxTokens: 0,
		reasoning: false,
		state: "-",
	}, {
		targetId: "unsafe",
		runtimeId: "local-native",
		modelId: "/home/operator/private-model.gguf",
		caps: "C------",
		contextWindow: 32_768,
		maxTokens: 4_096,
		reasoning: false,
		state: "loaded",
	}]);
	const profiles = projectRoutingProfiles([{
		name: "deep-research",
		target: "lab",
		runtime: "lmstudio",
		model: "qwen3.8-27b",
		thinkingLevel: "high",
		credentialPath: "/home/operator/private.json",
	}]);
	const bindings = projectRoutingBindings([{
		agentId: "researcher",
		profile: "deep-research",
		target: "lab",
		model: "qwen3.8-27b",
		warning: null,
		raw: "sk-routing-secret",
	}]);

	deepStrictEqual(models.items[0]?.capabilities, ["chat", "tools", "reasoning"]);
	equal(models.items[0]?.maxOutputTokens, 32_768);
	equal(models.emptyTargetCount, 1);
	equal(models.truncated, true);
	equal(profiles.items[0]?.thinkingLevel, "high");
	equal(bindings.items[0]?.resolved, true);
	const frame = JSON.stringify({ models, profiles, bindings });
	for (const forbidden of ["baseUrl", "operator:secret", "/home/operator", "credentialPath", "sk-routing-secret"]) {
		ok(!frame.includes(forbidden), `routing projection leaked ${forbidden}`);
	}
});

Deno.test("routing projection rejects contradictory capability and binding rows", () => {
	const models = projectRoutingModels([{
		targetId: "lab",
		runtimeId: "lmstudio",
		modelId: "contradictory",
		caps: "CTR----",
		contextWindow: 10,
		maxTokens: 10,
		reasoning: false,
		state: "loaded",
	}]);
	const bindings = projectRoutingBindings([{
		agentId: "researcher",
		profile: "missing",
		target: "lab",
		model: null,
		warning: "missing profile",
	}]);
	const profiles = projectRoutingProfiles([{
		name: "leaky-profile",
		target: "lab",
		runtime: "local-native",
		model: "file:///home/operator/private-model.gguf",
		thinkingLevel: "off",
	}]);
	deepStrictEqual(models.items, []);
	equal(models.truncated, true);
	deepStrictEqual(profiles.items, []);
	equal(profiles.truncated, true);
	deepStrictEqual(bindings.items, []);
	equal(bindings.truncated, true);
});

Deno.test("the routing adapter invokes only the three fixed offline JSON listings", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-routing-inspect-" });
	try {
		const inspection = await fixtureInspector().inspect(root);
		equal(inspection.inspectedAt, "2026-08-29T15:00:00.000Z");
		equal(inspection.models.availability, "available");
		equal(inspection.models.items[0]?.modelId, "qwen3.8-27b");
		equal(inspection.models.emptyTargetCount, 1);
		equal(inspection.profiles.items[0]?.name, "deep-research");
		equal(inspection.bindings.items[0]?.agentId, "researcher");
		equal(inspection.bindings.items[1]?.resolved, false);
		const frame = JSON.stringify(inspection);
		for (const forbidden of ["example.invalid", "/home/operator", "credentialPath", "diagnostic"]) {
			ok(!frame.includes(forbidden), `adapter leaked ${forbidden}`);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("one routing listing can fail without hiding the other collections", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-routing-partial-" });
	try {
		const inspection = await fixtureInspector("partial").inspect(root);
		equal(inspection.models.availability, "failed");
		deepStrictEqual(inspection.models.items, []);
		equal(inspection.profiles.availability, "available");
		equal(inspection.bindings.availability, "available");
		ok(!JSON.stringify(inspection).includes("sk-routing-secret"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
