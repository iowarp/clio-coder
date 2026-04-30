import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { resetXdgCache } from "../../src/core/xdg.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";

const ORIGINAL_ENV = { ...process.env };

const LEGACY_SETTINGS = `version: 1
identity: clio
defaultMode: default
safetyLevel: auto-edit
runtimePlugins: []
scope: []
budget:
  sessionCeilingUsd: 5
  concurrency: auto
theme: default
terminal:
  showTerminalProgress: false
keybindings: {}
state:
  lastMode: default
compaction:
  threshold: 0.8
  auto: true
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
targets:
  - id: mini
    runtime: llamacpp-completion
    url: http://127.0.0.1:8080
    defaultModel: dummy-model
orchestrator:
  target: mini
  model: dummy-model
  thinkingLevel: off
workers:
  default:
    target: mini
    model: dummy-model
    thinkingLevel: off
  profiles: {}
`;

describe("doctor legacy runtime migration", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-doctor-mig-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("warns when an endpoint pins an auto-migratable legacy runtime", () => {
		// `runDoctor()` calls `initializeClioHome()` first when fix is on, so
		// we always seed the directory layout up front.
		const configDir = join(scratch, "config");
		runDoctor({ fix: true });
		writeFileSync(join(configDir, "settings.yaml"), LEGACY_SETTINGS, "utf8");
		const findings = runDoctor();
		const target = findings.find((finding) => finding.name === "target mini");
		ok(target, "expected a target mini finding");
		strictEqual(target.ok, false);
		strictEqual(target.level, "warn");
		ok(target.detail.includes("llamacpp-completion"));
		ok(target.detail.includes("--fix"));
		ok(target.detail.includes("llamacpp"));
	});

	it("--fix rewrites the runtime field and the next run is clean", () => {
		const configDir = join(scratch, "config");
		runDoctor({ fix: true });
		writeFileSync(join(configDir, "settings.yaml"), LEGACY_SETTINGS, "utf8");

		const fixed = runDoctor({ fix: true });
		const target = fixed.find((finding) => finding.name === "target mini");
		ok(target);
		strictEqual(target.level, "warn");
		ok(target.detail.includes("migrated"));

		const after = readFileSync(join(configDir, "settings.yaml"), "utf8");
		const parsed = parseYaml(after) as { targets?: Array<{ id?: string; runtime?: string }> };
		const mini = parsed.targets?.find((entry) => entry?.id === "mini");
		strictEqual(mini?.runtime, "llamacpp");

		const second = runDoctor();
		const stillWarning = second.find((finding) => finding.name === "target mini" && finding.detail.includes("--fix"));
		strictEqual(stillWarning, undefined, "expected the warning to disappear after --fix");
	});

	it("warns but does not auto-migrate manual-hint legacy runtimes", () => {
		const configDir = join(scratch, "config");
		runDoctor({ fix: true });
		const manualSettings = LEGACY_SETTINGS.replace("llamacpp-completion", "llamacpp-anthropic");
		writeFileSync(join(configDir, "settings.yaml"), manualSettings, "utf8");

		const fixed = runDoctor({ fix: true });
		const target = fixed.find((finding) => finding.name === "target mini");
		ok(target);
		strictEqual(target.level, "warn");
		ok(target.detail.includes("hidden from the menu"));

		const after = readFileSync(join(configDir, "settings.yaml"), "utf8");
		const parsed = parseYaml(after) as { targets?: Array<{ runtime?: string }> };
		strictEqual(parsed.targets?.[0]?.runtime, "llamacpp-anthropic");
	});
});
