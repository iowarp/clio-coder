import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { loadManifestFromRoot, parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import { IGNORABLE_LIMITS, ManifestKeyPolicy, parseIgnorable } from "../../src/domains/extensions/ignorable.js";
import {
	capabilityEnvelope,
	envelopeDigest,
	parseExtensionRuntimeV2,
} from "../../src/domains/extensions/runtime-schema-v2.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	description: `Desk ${name}`,
	actionClass: "execute",
	inputSchema: { type: "object", properties: {} },
	...extra,
});
const manifest = (runtime: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	id: "desk",
	version: "0.1.0",
	description: "A desk.",
	runtime: { api: 2, entrypoint: "extension.mjs", ...runtime },
	...extra,
});
const parse = (value: Record<string, unknown>) => parseExtensionManifest(value, "/pkg/clio-coder-extension.yaml");
const errors = (result: ReturnType<typeof parse>) =>
	result.diagnostics.filter((entry) => entry.type === "error").map((entry) => entry.message);
const warnings = (result: ReturnType<typeof parse>) =>
	result.diagnostics.filter((entry) => entry.type === "warning").map((entry) => entry.message);
const digest = (result: ReturnType<typeof parse>) => {
	const declaration = result.manifest?.runtimeV2;
	ok(declaration, errors(result).join("; "));
	return envelopeDigest(capabilityEnvelope(declaration));
};

test("an unknown key listed as ignorable passes with one warning per path, at every manifest level", () => {
	const result = parse(
		manifest(
			{
				futureKey: { anything: true },
				tools: [tool("next_step", { cacheHint: "a" }), tool("gate", { cacheHint: "b" })],
				hooks: [{ on: "before_tool", priority: 3 }],
				permissions: { fs: { read: ["workspace"], quota: "1g" } },
				workspaces: [
					{ id: "desk", title: "Desk", regions: ["board"], keys: [{ key: "n", action: "a", label: "A", hint: "x" }] },
				],
			},
			{
				futureRoot: "x",
				compatibility: { node: ">=22" },
				ignorable: [
					"futureRoot",
					"compatibility.node",
					"runtime.futureKey",
					"runtime.tools.cacheHint",
					"runtime.hooks.priority",
					"runtime.permissions.fs.quota",
					"runtime.workspaces.keys.hint",
				],
			},
		),
	);
	deepStrictEqual(errors(result), []);
	ok(result.manifest);
	deepStrictEqual(
		warnings(result).map((message) => /ignores (\S+):/u.exec(message)?.[1]),
		[
			"compatibility.node",
			"futureRoot",
			"runtime.futureKey",
			"runtime.hooks.priority",
			"runtime.permissions.fs.quota",
			"runtime.tools.cacheHint",
			"runtime.workspaces.keys.hint",
		],
	);
	match(warnings(result)[0] ?? "", /^extension desk ignores compatibility\.node: this Clio does not know the field/u);
	// Ignored keys are never read into the declaration.
	ok(!("cacheHint" in (result.manifest.runtimeV2?.tools[0] ?? {})));
});

test("an unlisted unknown key still fails naming its path", () => {
	const listedElsewhere = { ignorable: ["runtime.tools.cacheHint"] };
	deepStrictEqual(errors(parse(manifest({ tools: [tool("gate", { cachehint: 1 })] }, listedElsewhere))), [
		"runtime.tools[0].cachehint is not a known field",
	]);
	// An indexed or partial path never matches: entries name the unindexed field exactly.
	deepStrictEqual(errors(parse(manifest({ futureKey: 1 }, { ignorable: ["runtime"] }))), [
		"runtime.futureKey is not a known field",
	]);
	deepStrictEqual(errors(parse(manifest({}, { futureRoot: 1 }))), ["unknown manifest key 'futureRoot'"]);
	deepStrictEqual(errors(parse(manifest({}, { compatibility: { node: "x" } }))), ["unknown compatibility key 'node'"]);
	// A plugin-owned key is known as a refusal, so listing it skips nothing.
	match(
		errors(parse(manifest({}, { skills: [], ignorable: ["skills"] })))[0] ?? "",
		/extensions cannot declare 'skills'/u,
	);
	// Malformed entries are refused by path, and the keys they meant to cover then fail too.
	equal(IGNORABLE_LIMITS.entries, 32);
	throws(() => parseIgnorable("runtime.promote"), /^Error: ignorable must be a list of field paths$/u);
	throws(() => parseIgnorable(["runtime.tools[0].readOnly"]), /^Error: ignorable\[0\] must be a dotted field path/u);
	throws(() => parseIgnorable(["runtime..promote"]), /^Error: ignorable\[0\] must be a dotted field path/u);
	throws(() => parseIgnorable(["a", 7]), /^Error: ignorable\[1\] must be a dotted field path/u);
	throws(() => parseIgnorable(["a", "a"]), /^Error: ignorable\[1\] repeats 'a'/u);
	throws(() => parseIgnorable(Array.from({ length: 33 }, (_, at) => `k${at}`)), /allows at most 32 entries/u);
	deepStrictEqual(errors(parse(manifest({ futureKey: 1 }, { ignorable: ["runtime.futureKey", 7] }))), [
		"ignorable[1] must be a dotted field path of at most 160 characters such as runtime.tools.readOnly, with list elements unindexed",
		"runtime.futureKey is not a known field",
	]);
});

test("a known key listed as ignorable is still parsed and enforced", () => {
	const listed = { ignorable: ["runtime.promote", "runtime.tools.readOnly"] };
	const result = parse(manifest({ tools: [tool("gate", { readOnly: true })], promote: ["gate"] }, listed));
	deepStrictEqual(result.diagnostics, []);
	deepStrictEqual(result.manifest?.runtimeV2?.promote, ["gate"]);
	equal(result.manifest?.runtimeV2?.tools[0]?.readOnly, true);
	deepStrictEqual(errors(parse(manifest({ tools: [tool("gate")], promote: ["missing"] }, listed))), [
		"runtime.promote[0] 'missing' is not a declared runtime tool",
	]);
	deepStrictEqual(errors(parse(manifest({ tools: [tool("gate", { readOnly: "yes" })] }, listed))), [
		"runtime.tools[0].readOnly must be true or false",
	]);
	// The runtime parser defaults to strict, so a caller without a policy refuses every unknown key.
	throws(
		() => parseExtensionRuntimeV2({ api: 2, entrypoint: "x.mjs", futureKey: 1 }),
		/runtime\.futureKey is not a known field/u,
	);
	const policy = new ManifestKeyPolicy(["runtime.futureKey"]);
	parseExtensionRuntimeV2({ api: 2, entrypoint: "x.mjs", futureKey: 1 }, policy);
	equal(policy.warnings("desk", "/m").length, 1);
});

test("the envelope digest is unchanged by an ignored key and by the ignorable list itself", () => {
	const runtime = { tools: [tool("gate")], hooks: [{ on: "before_tool", tools: ["gate"] }] };
	const plain = digest(parse(manifest(runtime)));
	equal(digest(parse(manifest(runtime, { ignorable: ["runtime.futureKey", "runtime.tools.cacheHint"] }))), plain);
	equal(
		digest(
			parse(
				manifest(
					{ ...runtime, futureKey: { grant: "everything" }, tools: [tool("gate", { cacheHint: "x" })] },
					{ ignorable: ["runtime.futureKey", "runtime.tools.cacheHint"] },
				),
			),
		),
		plain,
	);
});

test("extensions validate reads the warning from the package on disk and keeps the package valid", () => {
	const home = makeScratchHome("clio-coder-ignorable-");
	try {
		const root = path.join(home.dir, "desk");
		mkdirSync(root);
		writeFileSync(path.join(root, "extension.mjs"), "export default function register() {}\n");
		writeFileSync(
			path.join(root, "clio-coder-extension.yaml"),
			stringify(manifest({ futureKey: 1 }, { ignorable: ["runtime.futureKey"] })),
		);
		const candidate = loadManifestFromRoot(root);
		equal(candidate.valid, true);
		deepStrictEqual(
			candidate.diagnostics.map((entry) => entry.type),
			["warning"],
		);
	} finally {
		home.cleanup();
	}
});
