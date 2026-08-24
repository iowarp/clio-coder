import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readSettings, updateSettings } from "../../src/core/config.js";
import type { SafeCommandResult } from "../../src/core/safe-exec.js";
import {
	classifyLibraryRequirements,
	confirmLibraryRemote,
	discoverLibrary,
	discoverMarketplaceSkills,
	installLibraryPlan,
	type LibraryCommandRunner,
	type LibraryEntry,
	planLibraryInstall,
	resolveLibraryRequirements,
	syncLibrary,
} from "../../src/domains/resources/index.js";
import { normalizedSkillHash } from "../../src/domains/resources/skills/install.js";
import {
	type ClioShareArchive,
	createShareArchive,
	importShareArchive,
	planShareImport,
} from "../../src/domains/share/archive.js";
import { clearScratchClioHome, makeScratchHome, newScratchClioHome } from "../harness/scratch-env.js";
import { runCli } from "../harness/spawn.js";

const AGENT = `---
version: 1
name: Library Agent
description: A strict library recipe.
tools: {required: [read], optional: []}
skills: []
audience: custom
category: explore
capabilityClass: read-only
latencyClass: fast
projectContextTier: none
budget: {toolCalls: 8, readReserve: 1, synthesis: true}
resultContract: {kind: provenance-report}
tags: [library]
---

# Persona

Read carefully.
`;

const FLEET = `---
version: 3
name: library-fleet
description: A library fleet.
steps:
  - kind: agent
    id: inspect
    agent: verifier
    scope: readonly
    dependencies: []
maxWorkers: 1
onFailure: stop
---

Inspect {{task}}.
`;

const SKILL = `---
name: library-skill
description: A library skill.
---

# Library skill
`;

function entry(
	kind: LibraryEntry["kind"],
	name: string,
	sourceUrl: string,
	requires?: LibraryEntry["requires"],
): LibraryEntry {
	return { kind, name, description: name, sourceUrl, origin: "index", ...(requires ? { requires } : {}) };
}

function writeSources(root: string): Record<LibraryEntry["kind"], LibraryEntry> {
	const sources = path.join(root, "sources");
	mkdirSync(path.join(sources, "library-skill"), { recursive: true });
	writeFileSync(path.join(sources, "library-skill", "SKILL.md"), SKILL);
	writeFileSync(path.join(sources, "library-agent.md"), AGENT);
	writeFileSync(path.join(sources, "library-prompt.md"), "# Library prompt\n\nDo the requested work.\n");
	writeFileSync(path.join(sources, "library-fleet.md"), FLEET);
	return {
		skill: entry("skill", "library-skill", path.join(sources, "library-skill")),
		agent: entry("agent", "library-agent", path.join(sources, "library-agent.md")),
		prompt: entry("prompt", "library-prompt", path.join(sources, "library-prompt.md")),
		fleet: entry("fleet", "library-fleet", path.join(sources, "library-fleet.md")),
	};
}

function commandResult(stdout = ""): SafeCommandResult {
	return {
		file: "git",
		args: [],
		cwd: "/tmp",
		stdout,
		stderr: "",
		exitCode: 0,
		signal: null,
		aborted: false,
		timedOut: false,
		outputCapped: false,
		durationMs: 1,
	};
}

function writeCatalog(filePath: string, entries: ReadonlyArray<LibraryEntry>): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, stringifyYaml({ skills: entries }));
}

function writeChildSettings(configDir: string, catalog: string, overrides: Record<string, unknown> = {}): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		path.join(configDir, "settings.yaml"),
		stringifyYaml({ version: 1, library: { catalog, remote: null, confirmedRemote: null, sync: false, ...overrides } }),
	);
}

describe("contracts/resource-library", () => {
	let scratch: string;

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-resource-library-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	it("defaults historical rows and retains every explicit kind", () => {
		const indexPath = path.join(scratch, "index.json");
		writeFileSync(
			indexPath,
			JSON.stringify({
				skills: [
					{ name: "old", description: "old", sourceUrl: "/old" },
					...(["skill", "agent", "prompt", "fleet"] as const).map((kind) => ({
						name: kind,
						kind,
						description: kind,
						sourceUrl: `/${kind}`,
					})),
				],
			}),
		);
		const result = discoverMarketplaceSkills({ indexPath, catalogDir: null });
		strictEqual(result.skills.find((item) => item.name === "old")?.kind, "skill");
		deepStrictEqual(
			result.skills.filter((item) => item.name !== "old").map((item) => item.kind),
			["skill", "agent", "prompt", "fleet"],
		);
	});

	it("orders requirements and refuses missing, malformed, and cyclic graphs", () => {
		const skill = entry("skill", "base", "/tmp/base");
		const agent = entry("agent", "builder", "/tmp/builder", ["skill:base"]);
		const fleet = entry("fleet", "release", "/tmp/release", ["agent:builder"]);
		deepStrictEqual(
			resolveLibraryRequirements(fleet, [fleet, skill, agent]).map((item) => `${item.kind}:${item.name}`),
			["skill:base", "agent:builder", "fleet:release"],
		);
		throws(
			() => resolveLibraryRequirements(entry("agent", "a", "/tmp/a", ["skill:missing"]), []),
			/library_requirement_missing: skill:missing/,
		);
		throws(
			() => resolveLibraryRequirements(entry("agent", "a", "/tmp/a", ["missing"] as never), []),
			/library_requirement_malformed/,
		);
		const a = entry("agent", "a", "/tmp/a", ["fleet:b"]);
		const b = entry("fleet", "b", "/tmp/b", ["agent:a"]);
		throws(() => resolveLibraryRequirements(a, [a, b]), /library_requirement_cycle: agent:a -> fleet:b -> agent:a/);
	});

	it("installs every kind into its user root and records the validated hash", () => {
		const entries = writeSources(scratch);
		const plans = Object.values(entries).map(planLibraryInstall);
		for (const plan of plans) installLibraryPlan(plan);
		for (const plan of plans) {
			strictEqual(existsSync(plan.path), true);
		}
		const pins = parseYaml(readFileSync(path.join(scratch, "config", "library-pins.yaml"), "utf8")) as Record<
			string,
			{ sha256: string }
		>;
		for (const plan of plans) {
			const source = plan.entry.kind === "skill" ? path.join(plan.entry.sourceUrl, "SKILL.md") : plan.entry.sourceUrl;
			const raw = readFileSync(source);
			const expected =
				plan.entry.kind === "skill"
					? normalizedSkillHash(raw.toString("utf8"))
					: createHash("sha256").update(raw).digest("hex");
			strictEqual(pins[`${plan.entry.kind}:${plan.entry.name}`]?.sha256, expected);
		}
	});

	it("refuses malformed fleets and recipes before any destination or pin write", () => {
		const sources = path.join(scratch, "sources");
		mkdirSync(sources, { recursive: true });
		const badFleet = path.join(sources, "bad-fleet.md");
		const badAgent = path.join(sources, "bad-agent.md");
		writeFileSync(badFleet, "not a fleet");
		writeFileSync(badAgent, "not an agent");
		throws(() => planLibraryInstall(entry("fleet", "bad-fleet", badFleet)));
		throws(() => planLibraryInstall(entry("agent", "bad-agent", badAgent)));
		strictEqual(existsSync(path.join(scratch, "config", "fleets", "bad-fleet.md")), false);
		strictEqual(existsSync(path.join(scratch, "config", "agents", "bad-agent.md")), false);
		strictEqual(existsSync(path.join(scratch, "config", "library-pins.yaml")), false);
	});

	it("reads a private catalog, resolves relative sources, and overlays the same public ref", () => {
		const privateDir = path.join(scratch, "private");
		const publicDir = path.join(scratch, "public");
		mkdirSync(privateDir, { recursive: true });
		writeFileSync(path.join(privateDir, "prompt.md"), "private prompt\n");
		const publicIndex = path.join(publicDir, "marketplace.json");
		mkdirSync(publicDir, { recursive: true });
		writeFileSync(publicIndex, JSON.stringify({ skills: [entry("prompt", "overlay", "/public.md")] }));
		writeCatalog(path.join(privateDir, "library.yaml"), [entry("prompt", "overlay", "./prompt.md")]);
		updateSettings((settings) => {
			settings.library.catalog = path.join(privateDir, "library.yaml");
		});
		const result = discoverLibrary({ marketplace: { indexPath: publicIndex, catalogDir: null } });
		strictEqual(result.entries.find((item) => item.name === "overlay")?.sourceUrl, path.join(privateDir, "prompt.md"));
	});

	it("classifies pinned or present requirements as satisfied", () => {
		const entries = writeSources(scratch);
		const root = entry("fleet", "root", entries.fleet.sourceUrl, ["agent:library-agent", "prompt:library-prompt"]);
		mkdirSync(path.join(scratch, "config"), { recursive: true });
		writeFileSync(
			path.join(scratch, "config", "library-pins.yaml"),
			stringifyYaml({ "agent:library-agent": { sha256: "pinned", sourceUrl: entries.agent.sourceUrl } }),
		);
		mkdirSync(path.join(scratch, "config", "prompts"), { recursive: true });
		writeFileSync(path.join(scratch, "config", "prompts", "library-prompt.md"), "installed\n");
		const status = classifyLibraryRequirements(root, [root, entries.agent, entries.prompt]);
		deepStrictEqual(
			status.satisfied.map((item) => `${item.kind}:${item.name}`),
			["agent:library-agent", "prompt:library-prompt"],
		);
		deepStrictEqual(status.unsatisfied, []);
	});

	it("refuses disabled and unconfirmed synchronization without calling the runner", async () => {
		let calls = 0;
		const runner: LibraryCommandRunner = async () => {
			calls += 1;
			return commandResult();
		};
		await rejects(syncLibrary("sync", runner), /library_sync_disabled/);
		await rejects(syncLibrary("push", runner), /library_sync_disabled/);
		strictEqual(calls, 0);
		updateSettings((settings) => {
			settings.library.sync = true;
			settings.library.remote = "https://example.test/catalog.git";
		});
		await rejects(syncLibrary("sync", runner), /library_remote_unconfirmed/);
		strictEqual(calls, 0);
	});

	it("sets an absent remote during confirmation and refuses a configured mismatch", () => {
		const remote = "https://example.test/catalog.git";
		confirmLibraryRemote(remote);
		strictEqual(readSettings().library.remote, remote);
		strictEqual(readSettings().library.confirmedRemote, remote);
		updateSettings((settings) => {
			settings.library.remote = "https://example.test/other.git";
			settings.library.confirmedRemote = null;
		});
		throws(() => confirmLibraryRemote(remote), /library_remote_mismatch/);
		strictEqual(readSettings().library.confirmedRemote, null);
	});

	it("uses the exact no-shell git vectors for confirmed sync and push", async () => {
		const remote = "https://example.test/catalog.git";
		updateSettings((settings) => {
			settings.library.sync = true;
			settings.library.remote = remote;
			settings.library.confirmedRemote = remote;
		});
		const calls: Array<{ file: string; args: string[]; options: { cwd: string; workspaceRoot: string } }> = [];
		const runner: LibraryCommandRunner = async (file, args, options) => {
			calls.push({ file, args: [...args], options });
			return commandResult(args[0] === "remote" ? `${remote}\n` : "");
		};
		await syncLibrary("sync", runner);
		await syncLibrary("push", runner);
		deepStrictEqual(
			calls.map((call) => [call.file, ...call.args]),
			[
				["git", "remote", "get-url", "library"],
				["git", "fetch", "library"],
				["git", "merge", "--ff-only", "FETCH_HEAD"],
				["git", "remote", "get-url", "library"],
				["git", "push", "library"],
			],
		);
		ok(calls.every((call) => call.options.cwd === call.options.workspaceRoot));
	});

	it("exports and dry-runs agent and fleet share entries and rejects a malformed fleet", () => {
		const entries = writeSources(scratch);
		installLibraryPlan(planLibraryInstall(entries.agent));
		installLibraryPlan(planLibraryInstall(entries.fleet));
		const archive = createShareArchive({ scope: "user", includeAgents: true, includeFleets: true });
		deepStrictEqual(new Set(archive.files.map((file) => file.type)), new Set(["agent", "fleet"]));
		const archivePath = path.join(scratch, "share.json");
		writeFileSync(archivePath, JSON.stringify(archive));
		const dryRun = planShareImport(archivePath, { dryRun: true });
		ok(dryRun.actions.some((action) => action.type === "agent"));
		ok(dryRun.actions.some((action) => action.type === "fleet"));
		const malformed = structuredClone(archive) as ClioShareArchive;
		const fleet = malformed.files.find((file) => file.type === "fleet");
		ok(fleet);
		const bytes = Buffer.from("not a fleet\n");
		fleet.data = bytes.toString("base64");
		fleet.size = bytes.byteLength;
		fleet.sha256 = createHash("sha256").update(bytes).digest("hex");
		fleet.archivePath = "user/fleets/malformed-fleet.md";
		fleet.relativePath = "malformed-fleet.md";
		const manifestFleet = malformed.manifest.files.find((file) => file.type === "fleet");
		if (manifestFleet) {
			manifestFleet.size = fleet.size;
			manifestFleet.sha256 = fleet.sha256;
			manifestFleet.archivePath = fleet.archivePath;
			manifestFleet.relativePath = fleet.relativePath;
		}
		const malformedPath = path.join(scratch, "malformed-share.json");
		writeFileSync(malformedPath, JSON.stringify(malformed));
		const refused = importShareArchive(malformedPath);
		ok(
			refused.diagnostics.some(
				(diagnostic) => diagnostic.type === "error" && diagnostic.path?.endsWith("malformed-fleet.md"),
			),
		);
		strictEqual(existsSync(path.join(scratch, "config", "fleets", "malformed-fleet.md")), false);
	});
});

describe("contracts/resource-library CLI", () => {
	it("exports agent and fleet flags and dry-runs both archive kinds", async () => {
		const home = makeScratchHome("clio-library-cli-share-");
		try {
			const config = path.join(home.dir, "config");
			mkdirSync(path.join(config, "agents"), { recursive: true });
			mkdirSync(path.join(config, "fleets"), { recursive: true });
			writeFileSync(path.join(config, "agents", "library-agent.md"), AGENT);
			writeFileSync(path.join(config, "fleets", "library-fleet.md"), FLEET);
			writeChildSettings(config, path.join(home.dir, "library.yaml"));
			const archive = path.join(home.dir, "library-share.json");
			const exported = await runCli(["share", "export", "--out", archive, "--user", "--agents", "--fleets"], {
				env: home.env,
			});
			strictEqual(exported.code, 0);
			const parsed = JSON.parse(readFileSync(archive, "utf8")) as ClioShareArchive;
			deepStrictEqual(new Set(parsed.files.map((file) => file.type)), new Set(["agent", "fleet"]));
			const dryRun = await runCli(["share", "import", archive, "--dry-run"], { env: home.env });
			strictEqual(dryRun.code, 0);
			match(dryRun.stdout, /agent/);
			match(dryRun.stdout, /fleet/);
		} finally {
			home.cleanup();
		}
	});

	it("previews without yes and writes no destination or pin", async () => {
		const home = makeScratchHome("clio-library-cli-preview-");
		try {
			const sources = writeSources(home.dir);
			const catalog = path.join(home.dir, "catalog.yaml");
			writeCatalog(catalog, [sources.prompt]);
			writeChildSettings(path.join(home.dir, "config"), catalog);
			const result = await runCli(["library", "add", "prompt:library-prompt"], { env: home.env });
			strictEqual(result.code, 0);
			match(result.stdout, /prompt:library-prompt -> .*prompts\/library-prompt\.md sha256 [a-f0-9]{64}/);
			strictEqual(existsSync(path.join(home.dir, "config", "prompts", "library-prompt.md")), false);
			strictEqual(existsSync(path.join(home.dir, "config", "library-pins.yaml")), false);
		} finally {
			home.cleanup();
		}
	});

	it("refuses unsatisfied requirements, installs them in order, and skips an installed requirement", async () => {
		const home = makeScratchHome("clio-library-cli-requires-");
		try {
			const sources = writeSources(home.dir);
			const root: LibraryEntry = { ...sources.fleet, requires: ["prompt:library-prompt"] };
			const catalog = path.join(home.dir, "catalog.yaml");
			writeCatalog(catalog, [sources.prompt, root]);
			writeChildSettings(path.join(home.dir, "config"), catalog);
			const refused = await runCli(["library", "add", "fleet:library-fleet", "--yes"], { env: home.env });
			strictEqual(refused.code, 1);
			match(refused.stderr, /prompt:library-prompt/);
			strictEqual(existsSync(path.join(home.dir, "config", "fleets", "library-fleet.md")), false);
			const installed = await runCli(["library", "add", "fleet:library-fleet", "--with-requirements", "--yes"], {
				env: home.env,
			});
			strictEqual(installed.code, 0);
			ok(installed.stdout.indexOf("prompt:library-prompt ->") < installed.stdout.indexOf("fleet:library-fleet ->"));
			strictEqual(existsSync(path.join(home.dir, "config", "prompts", "library-prompt.md")), true);
			strictEqual(existsSync(path.join(home.dir, "config", "fleets", "library-fleet.md")), true);

			const secondRoot: LibraryEntry = {
				...sources.agent,
				name: "second-agent",
				requires: ["prompt:library-prompt"],
			};
			writeCatalog(catalog, [sources.prompt, secondRoot]);
			const second = await runCli(["library", "add", "agent:second-agent", "--with-requirements"], { env: home.env });
			strictEqual(second.code, 0);
			match(second.stdout, /satisfied requirements: prompt:library-prompt/);
			strictEqual((second.stdout.match(/prompt:library-prompt ->/g) ?? []).length, 0);
		} finally {
			home.cleanup();
		}
	});

	it("reports use output for every kind and points a skill at its hub", async () => {
		const home = makeScratchHome("clio-library-cli-use-");
		try {
			for (const [kind, expected] of [
				["agent", "/run demo\n"],
				["prompt", "demo\n"],
				["fleet", "clio-coder fleet run demo\n"],
			] as const) {
				const result = await runCli(["library", "use", kind, "demo"], { env: home.env });
				strictEqual(result.code, 0);
				strictEqual(result.stdout, expected);
			}
			// There is no `skills use` verb: a skill is loaded from the hub, so the
			// answer is where it lives and how to load it, never a fabricated command.
			const library = await runCli(["library", "use", "skill", "demo"], { env: home.env });
			strictEqual(library.code, 0);
			match(library.stdout, /skills\/demo\/SKILL\.md\n/);
			match(library.stdout, /load it from \/skill in the TUI/);
		} finally {
			home.cleanup();
		}
	});

	it("returns named JSON and stderr refusals while synchronization is disabled", async () => {
		const home = makeScratchHome("clio-library-cli-sync-");
		try {
			writeChildSettings(path.join(home.dir, "config"), path.join(home.dir, "library.yaml"));
			for (const command of ["sync", "push"] as const) {
				const result = await runCli(["library", command, "--json"], { env: home.env });
				strictEqual(result.code, 1);
				match(result.stderr, /library_sync_disabled/);
				strictEqual(JSON.parse(result.stdout).error, "library_sync_disabled");
			}
		} finally {
			home.cleanup();
		}
	});
});
