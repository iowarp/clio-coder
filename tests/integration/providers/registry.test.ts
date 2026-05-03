import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createRuntimeRegistry, getRuntimeRegistry } from "../../../src/domains/providers/registry.js";
import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";

function fakeDescriptor(id: string, overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
		synthesizeModel: () => ({ id, provider: id }) as never,
		...overrides,
	};
}

describe("providers/registry createRuntimeRegistry", () => {
	it("register() adds a descriptor and get/list reflect it", () => {
		const registry = createRuntimeRegistry();
		const desc = fakeDescriptor("test-1");
		registry.register(desc);
		strictEqual(registry.get("test-1"), desc);
		const all = registry.list();
		strictEqual(all.length, 1);
		strictEqual(all[0], desc);
	});

	it("register() throws the canonical duplicate message", () => {
		const registry = createRuntimeRegistry();
		registry.register(fakeDescriptor("dup"));
		throws(
			() => registry.register(fakeDescriptor("dup")),
			(err: Error) => err.message === "runtime id 'dup' already registered",
		);
	});

	it("get() returns null for an unknown id", () => {
		const registry = createRuntimeRegistry();
		strictEqual(registry.get("nope"), null);
	});

	it("clear() wipes state so a fresh register sees an empty map", () => {
		const registry = createRuntimeRegistry();
		registry.register(fakeDescriptor("a"));
		registry.register(fakeDescriptor("b"));
		strictEqual(registry.list().length, 2);
		registry.clear();
		strictEqual(registry.list().length, 0);
		strictEqual(registry.get("a"), null);
		registry.register(fakeDescriptor("a"));
		strictEqual(registry.get("a") !== null, true);
	});
});

describe("providers/registry loadFromDir", () => {
	let scratch: string;
	let stderrWrites: string[];
	let originalWrite: typeof process.stderr.write;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-registry-"));
		stderrWrites = [];
		originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		process.stderr.write = originalWrite;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns [] when the directory does not exist (no throw)", async () => {
		const registry = createRuntimeRegistry();
		const loaded = await registry.loadFromDir(join(scratch, "missing"));
		deepStrictEqual(Array.from(loaded), []);
	});

	it("returns [] when the path exists but is a file, not a directory", async () => {
		const registry = createRuntimeRegistry();
		const filePath = join(scratch, "not-a-dir");
		writeFileSync(filePath, "");
		const loaded = await registry.loadFromDir(filePath);
		deepStrictEqual(Array.from(loaded), []);
	});

	it("loads out-of-tree SDK runtime descriptors", async () => {
		const registry = createRuntimeRegistry();
		const pluginPath = join(scratch, "sdk-plugin.js");
		writeFileSync(
			pluginPath,
			`
const caps = { chat: true, tools: false, reasoning: false, vision: false, audio: false, embeddings: false, rerank: false, fim: false, contextWindow: 1024, maxTokens: 128 };
export default {
  id: "out-of-tree-sdk",
  displayName: "Out Of Tree SDK",
  kind: "sdk",
  tier: "sdk",
  apiFamily: "example-sdk",
  auth: "none",
  defaultCapabilities: caps,
  synthesizeModel() {
    return { id: "model", provider: "example-sdk" };
  },
};
`,
			"utf8",
		);

		const loaded = await registry.loadFromDir(scratch);

		deepStrictEqual(Array.from(loaded), ["out-of-tree-sdk"]);
		strictEqual(registry.get("out-of-tree-sdk")?.kind, "sdk");
		deepStrictEqual(stderrWrites, []);
	});

	it("logs a field-specific reason for invalid descriptor kind", async () => {
		const registry = createRuntimeRegistry();
		const pluginPath = join(scratch, "invalid-plugin.js");
		writeFileSync(
			pluginPath,
			`
export default {
  id: "bad-runtime",
  displayName: "Bad Runtime",
  kind: "socket",
  apiFamily: "example-sdk",
  auth: "none",
  defaultCapabilities: {},
  synthesizeModel() {
    return { id: "model", provider: "bad" };
  },
};
`,
			"utf8",
		);

		const loaded = await registry.loadFromDir(scratch);

		deepStrictEqual(Array.from(loaded), []);
		const joined = stderrWrites.join("");
		ok(joined.includes("invalid default-export RuntimeDescriptor"), joined);
		ok(joined.includes("kind must be one of http, subprocess, sdk"), joined);
	});
});

describe("providers/registry loadFromPackage", () => {
	let scratch: string;
	let stderrWrites: string[];
	let originalWrite: typeof process.stderr.write;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-registry-pkg-"));
		stderrWrites = [];
		originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		process.stderr.write = originalWrite;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("missing package logs to stderr and returns [] without throwing", async () => {
		const registry = createRuntimeRegistry();
		const loaded = await registry.loadFromPackage("@clio-test/does-not-exist-pkg");
		deepStrictEqual(Array.from(loaded), []);
		const joined = stderrWrites.join("");
		ok(joined.includes("does-not-exist-pkg"), `expected stderr to mention the package, got: ${joined}`);
	});
});

describe("providers/registry getRuntimeRegistry singleton", () => {
	it("returns the same instance across calls", () => {
		const a = getRuntimeRegistry();
		const b = getRuntimeRegistry();
		strictEqual(a, b);
	});

	it("clear() on the singleton wipes state observable to all callers", () => {
		const reg = getRuntimeRegistry();
		reg.clear();
		reg.register(fakeDescriptor("singleton-x"));
		strictEqual(getRuntimeRegistry().get("singleton-x") !== null, true);
		reg.clear();
		strictEqual(getRuntimeRegistry().get("singleton-x"), null);
	});
});
