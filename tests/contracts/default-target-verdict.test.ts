/**
 * The launch-time readiness check reports a cause, not a boolean.
 *
 * The distinction that matters is the last case: a target that is declared,
 * present, and orchestrator-eligible, whose only unresolved piece is a
 * credential. That is not a target-selection problem, and treating it as one
 * sent a working local installation into the runtime-selection wizard on
 * every launch.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { classifyDefaultTarget } from "../../src/cli/default-target.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

function writeSettings(dir: string, patch: Record<string, unknown>): void {
	const settings = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
	writeFileSync(join(dir, "config", "settings.yaml"), stringifyYaml({ ...settings, ...patch }), "utf8");
}

describe("contracts/default-target verdict", { concurrency: false }, () => {
	let dir: string;

	beforeEach(async () => {
		dir = await newScratchClioHome("clio-default-target-");
		// The scratch home is an empty directory. Creating the config root here
		// keeps the bootstrap, which is not what these cases are about, out of
		// the way.
		mkdirSync(join(dir, "config"), { recursive: true });
	});

	afterEach(() => {
		clearScratchClioHome(dir);
	});

	it("reports no-target when nothing is configured", () => {
		writeSettings(dir, { targets: [], orchestrator: { target: null, model: null, thinkingLevel: "off" } });
		deepStrictEqual(classifyDefaultTarget(), { kind: "no-target" });
	});

	it("reads a deleted chat target as no target rather than a dangling name", () => {
		// The schema normalizes a routing reference to a target that is gone,
		// so this arrives as no-target and never as a fourth verdict.
		writeSettings(dir, { targets: [], orchestrator: { target: "ghost", model: null, thinkingLevel: "off" } });
		deepStrictEqual(classifyDefaultTarget(), { kind: "no-target" });
	});

	it("reports usable for a keyless local target", () => {
		writeSettings(dir, {
			targets: [{ id: "local", runtime: "ollama-native", url: "http://127.0.0.1:11434", defaultModel: "m" }],
			orchestrator: { target: "local", model: "m", thinkingLevel: "off" },
		});
		deepStrictEqual(classifyDefaultTarget(), { kind: "usable" });
	});

	it("separates a missing credential from a missing target", () => {
		writeSettings(dir, {
			targets: [
				{
					id: "remote",
					runtime: "lmstudio-native",
					url: "http://127.0.0.1:1234",
					defaultModel: "m",
					auth: { apiKeyRef: "lmstudio-native" },
				},
			],
			orchestrator: { target: "remote", model: "m", thinkingLevel: "off" },
		});
		const verdict = classifyDefaultTarget();
		strictEqual(verdict.kind, "missing-credential");
		if (verdict.kind !== "missing-credential") return;
		strictEqual(verdict.targetId, "remote");
		strictEqual(verdict.store, "lmstudio-native");
	});

	it("recognizes stored OAuth during the lightweight preflight", () => {
		writeSettings(dir, {
			targets: [{ id: "codex", runtime: "openai-codex", defaultModel: "m" }],
			orchestrator: { target: "codex", model: "m", thinkingLevel: "off" },
		});
		writeFileSync(
			join(dir, "config", "credentials.yaml"),
			stringifyYaml({
				version: 2,
				entries: {
					"openai-codex": { type: "oauth", access: "access", refresh: "refresh", expires: 1, updatedAt: "now" },
				},
			}),
			"utf8",
		);
		deepStrictEqual(classifyDefaultTarget(), { kind: "usable" });
	});

	it("recognizes the runtime's explicit environment credential", () => {
		writeSettings(dir, {
			targets: [{ id: "openai", runtime: "openai", defaultModel: "m" }],
			orchestrator: { target: "openai", model: "m", thinkingLevel: "off" },
		});
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key";
		try {
			deepStrictEqual(classifyDefaultTarget(), { kind: "usable" });
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});
});
