import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { resolve } from "node:path";
import { it } from "node:test";
import type { SemanticCliContext, SemanticCliRequest } from "../../src/cli/semantic.js";
import { parseSemanticArgs, runSemanticCommand } from "../../src/cli/semantic.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";

it("parses semantic pins, inbox operations and bounded search filters", () => {
	const cwd = process.cwd();
	assert.deepEqual(
		parseSemanticArgs(
			[
				"configure",
				"--target",
				"embed",
				"--model",
				"gemma",
				"--asset-identity",
				"sha256:pin",
				"--projector-identity",
				"sha256:projector",
				"--profile",
				"q8",
			],
			cwd,
		).request,
		{
			command: "configure",
			target: "embed",
			model: "gemma",
			assetIdentity: "sha256:pin",
			qualify: false,
			projectorIdentity: "sha256:projector",
			profile: "q8",
		},
	);
	assert.deepEqual(parseSemanticArgs(["inbox", "add", "science", "--id", "lab"], cwd).request, {
		command: "inbox-add",
		root: resolve(cwd, "science"),
		id: "lab",
		scope: "project",
	});
	assert.equal(
		parseSemanticArgs(
			["configure", "--target", "embed", "--model", "gemma", "--asset-identity", "hash", "--background"],
			cwd,
		).request.command,
		"configure",
	);
	assert.equal(
		(
			parseSemanticArgs(
				["configure", "--target", "embed", "--model", "gemma", "--asset-identity", "hash", "--background"],
				cwd,
			).request as { background?: boolean }
		).background,
		true,
	);
	assert.deepEqual(parseSemanticArgs(["inbox", "preview", "science"], cwd).request, {
		command: "inbox-preview",
		root: resolve(cwd, "science"),
	});
	assert.deepEqual(parseSemanticArgs(["inbox", "remove", "lab"], cwd).request, { command: "inbox-remove", id: "lab" });
	assert.deepEqual(parseSemanticArgs(["inbox", "list"], cwd).request, { command: "inbox-list" });
	assert.deepEqual(parseSemanticArgs(["refresh", "--rebuild"], cwd).request, { command: "refresh", rebuild: true });
	assert.deepEqual(parseSemanticArgs(["reembed", "--profile", "q8"], cwd).request, {
		command: "reembed",
		profile: "q8",
	});
	assert.deepEqual(parseSemanticArgs(["reembed", "--profile", "q8", "--from", "a".repeat(64)], cwd).request, {
		command: "reembed",
		profile: "q8",
		from: "a".repeat(64),
	});
	assert.deepEqual(parseSemanticArgs([], cwd).request, { command: "status" });
	assert.deepEqual(
		parseSemanticArgs(
			[
				"search",
				"delayed oscillation",
				"--limit",
				"5",
				"--kind",
				"inbox",
				"--kind",
				"code",
				"--project",
				"p",
				"--run",
				"r",
				"--since",
				"2026-10-01",
				"--until",
				"2026-10-07",
				"--media-type",
				"image/png",
				"--json",
			],
			cwd,
		),
		{
			json: true,
			request: {
				command: "search",
				query: "delayed oscillation",
				limit: 5,
				kinds: ["inbox", "code"],
				project: "p",
				run: "r",
				since: "2026-10-01T00:00:00.000Z",
				until: "2026-10-07T23:59:59.999Z",
				mediaType: "image/png",
			},
		},
	);
	assert.equal(parseSemanticArgs(["search", "--", "--literal-query"], cwd).request.command, "search");
});

it("refuses missing pins, unbounded results and invalid flags before executing", async () => {
	let calls = 0;
	for (const args of [
		["configure"],
		["configure", "--target", "x", "--model", "m"],
		["inbox", "add", "science"],
		["inbox", "add", "science", "--id", "x", "--scope", "foreign"],
		["reembed"],
		["search", "q", "--limit", "21"],
		["search", "q", "--limit", "NaN"],
		["search", "q", "--since", "2026-02-30"],
		["search", "q", "--since", "2026-10-07", "--until", "2026-10-01"],
		["search", "q", "--limit", "2", "--limit", "3"],
		["status", "--rebuild"],
		["refresh", "unexpected"],
		["unknown"],
	]) {
		const code = await runSemanticCommand(args, {
			loadContext: async () => {
				calls++;
				throw new Error("must not read config");
			},
			writeOut: () => {},
			writeError: () => {},
		});
		assert.equal(code, 2, args.join(" "));
	}
	assert.equal(calls, 0);
	let help = "";
	assert.equal(
		await runSemanticCommand(["inbox", "--help"], {
			loadContext: async () => {
				calls++;
				throw new Error("must not load");
			},
			writeOut: (text) => {
				help += text;
			},
		}),
		0,
	);
	assert.match(help, /asset-identity/);
	assert.equal(calls, 0);
});

it("delegates operations with settings APIs, renders JSON and removes signal listeners", async () => {
	const requests: SemanticCliRequest[] = [];
	const settings = structuredClone(DEFAULT_SETTINGS);
	const updateSettings: SemanticCliContext["updateSettings"] = () => {
		throw new Error("executor owns writes");
	};
	const before = getEventListeners(process, "SIGINT").length;
	let output = "";
	const dependencies = {
		loadContext: async () => ({ cwd: process.cwd(), settings, updateSettings }),
		execute: async (request: SemanticCliRequest, context: SemanticCliContext) => {
			requests.push(request);
			assert.equal(context.settings, settings);
			assert.equal(context.updateSettings, updateSettings);
			assert.equal(context.signal.aborted, false);
			return { generation: 2, hits: [{ path: "simulation.py", location: { line: 12 } }] };
		},
		writeOut: (text: string) => {
			output += text;
		},
		writeError: () => {},
	};
	assert.equal(await runSemanticCommand(["search", "delayed oscillation", "--json"], dependencies), 0);
	assert.deepEqual(requests, [{ command: "search", query: "delayed oscillation", limit: 5 }]);
	assert.equal(output, '{"generation":2,"hits":[{"path":"simulation.py","location":{"line":12}}]}\n');
	assert.equal(getEventListeners(process, "SIGINT").length, before);
	assert.equal(
		await runSemanticCommand(["status"], {
			...dependencies,
			execute: async () => {
				throw new Error("index unavailable");
			},
		}),
		1,
	);
	assert.equal(getEventListeners(process, "SIGINT").length, before);
	assert.equal(
		await runSemanticCommand(["refresh"], {
			...dependencies,
			execute: async (_request, context) => {
				process.emit("SIGINT");
				assert.equal(context.signal.aborted, true);
				return null;
			},
		}),
		130,
	);
	assert.equal(getEventListeners(process, "SIGINT").length, before);
});

it("uses the manager bridge with preview-before-save, exact profile pins and project isolation", async () => {
	const { executeSemanticRequest } = await import("../../src/cli/semantic.js");
	const { realpathSync } = await import("node:fs");
	const cwd = realpathSync(process.cwd());
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "embedding", runtime: "litellm", url: "http://fixture.invalid" }];
	const semantic = {
		enabled: false,
		target: null as string | null,
		model: null as string | null,
		assetIdentity: null as string | null,
		projectorIdentity: null as string | null,
		canaryFingerprint: null as string | null,
		modalities: ["text"],
		background: false,
		inboxes: [] as Array<{ id: string; root: string; scope: string; project: string | null }>,
	};
	Object.assign(settings.context, { semantic });
	const events: string[] = [];
	const updateSettings: SemanticCliContext["updateSettings"] = (mutate) => {
		events.push("save");
		return mutate(settings) ?? settings;
	};
	const context = { cwd, settings, updateSettings, signal: new AbortController().signal };
	const bridge: import("../../src/cli/semantic.js").SemanticCliBridge = {
		openSemanticApp: async () => ({ profile: { id: "embeddinggemma-2-q8-768" }, profileIdentity: "exact-profile" }),
		previewSemanticInbox: async (_options, id) => {
			events.push(`preview:${id}`);
			return { files: 2, bytes: 100 };
		},
		refreshSemantic: async () => {
			events.push("refresh");
			return { complete: true };
		},
		reembedSemantic: async () => {
			events.push("reembed");
			return { complete: true };
		},
		searchSemantic: async (_options, query, filters) => {
			events.push("search");
			return { query, filters };
		},
		statusSemantic: async () => ({ generation: 1 }),
		qualifySemantic: async () => {
			events.push("qualify");
			return { canaryFingerprint: "fixed-canary" };
		},
	};
	assert.deepEqual(await executeSemanticRequest({ command: "status" }, context, bridge), {
		enabled: false,
		configured: false,
		inboxes: [],
	});
	await executeSemanticRequest(
		{ command: "configure", target: "embedding", model: "gemma", assetIdentity: "pinned", qualify: true },
		context,
		bridge,
	);
	assert.deepEqual(events, ["qualify", "save"]);
	const saved = () => (settings.context as typeof settings.context & { semantic: typeof semantic }).semantic;
	assert.equal(saved().canaryFingerprint, "fixed-canary");
	assert.equal(saved().background, false);
	events.length = 0;
	await executeSemanticRequest({ command: "qualify" }, context, bridge);
	assert.deepEqual(events, ["qualify", "save"]);
	events.length = 0;
	await assert.rejects(
		executeSemanticRequest({ command: "qualify" }, context, {
			...bridge,
			qualifySemantic: async () => {
				throw new Error("canary mismatch");
			},
		}),
		/canary mismatch/,
	);
	assert.deepEqual(events, []);
	events.length = 0;
	await executeSemanticRequest({ command: "inbox-add", root: cwd, id: "science", scope: "project" }, context, bridge);
	assert.deepEqual(events, ["preview:science", "save"]);
	assert.equal(saved().inboxes.length, 1);
	assert.equal(saved().inboxes[0]?.project, cwd);
	await assert.rejects(
		executeSemanticRequest({ command: "inbox-add", root: cwd, id: "science", scope: "project" }, context, bridge),
		/already registered/,
	);
	await executeSemanticRequest({ command: "inbox-preview", root: cwd }, context, bridge);
	assert.equal(saved().inboxes.length, 1);
	await executeSemanticRequest({ command: "inbox-add", root: cwd, id: "shared", scope: "user" }, context, bridge);
	assert.equal(saved().inboxes[1]?.scope, "global");
	assert.equal(saved().inboxes[1]?.project, null);
	await executeSemanticRequest({ command: "inbox-remove", id: "science" }, context, bridge);
	assert.equal(saved().inboxes.length, 1);
	events.length = 0;
	await assert.rejects(
		executeSemanticRequest({ command: "reembed", profile: "foreign" }, context, bridge),
		/must match/,
	);
	assert.deepEqual(events, []);
	await executeSemanticRequest({ command: "reembed", profile: "exact-profile" }, context, bridge);
	assert.deepEqual(events, ["reembed"]);
	await executeSemanticRequest({ command: "refresh", rebuild: true }, context, bridge);
	assert.deepEqual(events, ["reembed", "refresh", "reembed"]);
	events.length = 0;
	const incomplete = {
		result: { complete: false, failed: [{ id: "source", error: "HTTP 401" }] },
		sources: [{ state: "unsupported", path: "clip.mp4" }],
	};
	assert.deepEqual(
		await executeSemanticRequest({ command: "refresh", rebuild: true }, context, {
			...bridge,
			refreshSemantic: async () => incomplete,
		}),
		incomplete,
	);
	assert.deepEqual(events, []);
	await assert.rejects(
		executeSemanticRequest({ command: "search", query: "q", limit: 5, project: "foreign" }, context, bridge),
		/current canonical project/,
	);
	assert.deepEqual(
		await executeSemanticRequest(
			{ command: "search", query: "q", limit: 5, run: "run-1", kinds: ["inbox"], since: "2026-10-01" },
			context,
			bridge,
		),
		{ query: "q", filters: { limit: 5, runId: "run-1", kinds: ["inbox"], after: "2026-10-01" } },
	);
});

it("reports incomplete indexing as failure while preserving failed and unsupported source details", async () => {
	let output = "";
	let errors = "";
	const result = {
		result: { complete: false, failed: [{ id: "note", error: "HTTP 401" }] },
		sources: [{ path: "clip.mp4", state: "unsupported" }],
	};
	const code = await runSemanticCommand(["refresh", "--json"], {
		loadContext: async () => ({
			cwd: process.cwd(),
			settings: structuredClone(DEFAULT_SETTINGS),
			updateSettings: () => {
				throw new Error("no writes");
			},
		}),
		execute: async () => result,
		writeOut: (text) => {
			output += text;
		},
		writeError: (text) => {
			errors += text;
		},
	});
	assert.equal(code, 1);
	assert.deepEqual(JSON.parse(output), result);
	assert.match(errors, /indexing incomplete/);
	assert.match(output, /unsupported/);
	assert.match(output, /HTTP 401/);
});
