import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	agentSkillToolPolicy,
	skillActivationFromToolDetails,
	withModelSkillActivation,
} from "../../src/core/skill-activation.js";
import { clioConfigDir as configDir } from "../../src/core/xdg.js";
import { PLUGIN_SCHEMA } from "../../src/domains/plugins/discovery.js";
import { clearPluginSnapshots, pluginContentDigest } from "../../src/domains/plugins/index.js";
import { buildSkillCatalogView } from "../../src/domains/resources/skills/catalog-view.js";
import { lexicalMatches } from "../../src/domains/resources/skills/lexical-match.js";
import { loadSkills, type Skill } from "../../src/domains/resources/skills/loader.js";
import { checkSkillDrift, checkSkillDriftBatch } from "../../src/domains/resources/skills/provenance-pin.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { OBSERVE_SELF_CAPS } from "../../src/tools/observation.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Whole-response byte fitting, pagination under a filter, and the production
 * wiring in the context tool.
 *
 * The earlier catalog tests measured the renderer at a roomy 50 KiB. These
 * measure the properties that only appear at the edges: a caller-supplied query
 * with no length limit, a catalog where everything drifted, a reservation at
 * the shared pool's floor, an inventory that fits the cap exactly, and a
 * continuation that has to survive being followed.
 */

const B = (text: string) => Buffer.byteLength(text, "utf8");

function skill(name: string, description: string, over: Partial<Skill> = {}): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		content: "body",
		sourceInfo: { path: `/skills/${name}/SKILL.md`, scope: "user" },
		disableModelInvocation: false,
		source: "clio-coder",
		scope: "user",
		hash: "0".repeat(64),
		normalizedHash: "0".repeat(64),
		pathSubject: name,
		trusted: true,
		precedence: 30,
		metadata: {},
		diagnostics: [],
		...over,
	} as Skill;
}

const BASE = { packages: [], marketplace: [], marketplaceOffered: true, modelActivation: false } as const;

describe("contracts/skills catalog whole-response byte fitting", () => {
	it("bounds a query with no length limit instead of echoing it whole", () => {
		// The schema puts no ceiling on `query`. Echoing it into the note let one
		// argument decide the size of a response this module exists to bound.
		const view = buildSkillCatalogView({
			...BASE,
			skills: [skill("alpha", "A skill.")],
			capBytes: 2500,
			query: "漢".repeat(3000),
		});
		ok(B(view.text) <= 2500, `returned ${B(view.text)} bytes against a 2500-byte cap`);
		ok(view.text.includes("…"), "the echoed query is elided rather than dropped silently");
	});

	it("never splits a surrogate pair while bounding an echoed query", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: [skill("alpha", "A skill.")],
			capBytes: 2500,
			query: "🙂".repeat(400),
		});
		ok(B(view.text) <= 2500);
		ok(!view.text.includes("�"), "no replacement character from a half-cut code point");
	});

	it("bounds the drift notice when the whole catalog drifted", () => {
		const many = Array.from({ length: 100 }, (_, i) =>
			skill(`drifted-skill-name-that-is-fairly-long-${String(i).padStart(3, "0")}`, "Description."),
		);
		const view = buildSkillCatalogView({
			...BASE,
			skills: many,
			drifted: new Set(many.map((entry) => entry.name)),
			capBytes: 2500,
		});
		ok(B(view.text) <= 2500, `returned ${B(view.text)} bytes against a 2500-byte cap`);
		ok(view.text.includes("and "), "the notice reports a remainder rather than naming all 100");
	});

	it("returns a complete inventory that fits the cap exactly", () => {
		// Reserving scaffolding for sections that do not exist used to drop a
		// complete listing whose real rendering fitted with room to spare.
		const twelve = Array.from({ length: 12 }, (_, i) => skill(`s${i}`, "Short."));
		const roomy = buildSkillCatalogView({ ...BASE, skills: twelve, capBytes: 50 * 1024 });
		strictEqual(roomy.shown, 12);
		const exact = buildSkillCatalogView({ ...BASE, skills: twelve, capBytes: B(roomy.text) });
		strictEqual(exact.shown, 12, "an exactly-fitting inventory is not cut");
		strictEqual(exact.text, roomy.text, "and renders identically");
		strictEqual(exact.budgetLimited, false);
		strictEqual(exact.nextOffset, undefined);
	});

	it("carries rows at the shared pool's minimum reservation", () => {
		const view = buildSkillCatalogView({ ...BASE, skills: [skill("one", "Short.")], capBytes: 1024 });
		strictEqual(view.shown, 1, "a one-row catalog fits a 1 KiB reservation");
		ok(B(view.text) <= 1024);
	});

	it("stays inside the cap across a sweep of reservations and catalog sizes", () => {
		for (const rows of [1, 12, 60, 300]) {
			const skills = Array.from({ length: rows }, (_, i) => skill(`s${String(i).padStart(3, "0")}`, `D${i}. `.repeat(8)));
			for (const cap of [256, 512, 1024, 2048, 4096, 16384, OBSERVE_SELF_CAPS.contextSkills]) {
				const view = buildSkillCatalogView({ ...BASE, skills, capBytes: cap, modelActivation: true });
				ok(B(view.text) <= cap, `rows=${rows} cap=${cap} returned ${B(view.text)} bytes`);
			}
		}
	});

	it("falls back to one honest line when the budget cannot carry the scaffolding", () => {
		const twelve = Array.from({ length: 12 }, (_, i) => skill(`s${i}`, "Short."));
		const view = buildSkillCatalogView({ ...BASE, skills: twelve, capBytes: 300 });
		ok(B(view.text) <= 300);
		strictEqual(view.shown, 0);
		ok(view.budgetLimited);
		ok(view.text.includes("cannot carry the listing"), view.text);
		ok(view.text.includes('query="<terms>"'), "it names the argument that makes the listing smaller");
	});

	it("steps over a row too large to carry rather than dead-ending on it", () => {
		const skills = [skill("huge", "x".repeat(3000)), skill("small", "Short.")];
		const first = buildSkillCatalogView({ ...BASE, skills, capBytes: 2000 });
		ok(B(first.text) <= 2000);
		strictEqual(first.shown, 0);
		strictEqual(first.nextOffset, 1, "paging advances past the blocking row");
		ok(first.text.includes('"huge" is too large'), first.text);
		ok(first.text.includes('name="huge"'), "it names the route that can still reach the row");
		const next = buildSkillCatalogView({ ...BASE, skills, capBytes: 2000, offset: first.nextOffset });
		strictEqual(next.shown, 1);
		strictEqual(next.rows[0]?.name, "small", "the rows behind it stay reachable");
	});
});

describe("contracts/skills catalog filtered pagination", () => {
	// Ordering matters: matching rows are interleaved with non-matching ones, so
	// an offset applied to the unfiltered set lands somewhere else entirely.
	const catalog = [
		skill("alpha", "Unrelated."),
		skill("git-one", "A git thing."),
		skill("beta", "Unrelated too."),
		skill("git-two", "Another git thing."),
	];

	it("keeps the query in the continuation it recommends", () => {
		const first = buildSkillCatalogView({ ...BASE, skills: catalog, capBytes: 50 * 1024, query: "git", limit: 1 });
		strictEqual(first.rows[0]?.name, "git-one");
		strictEqual(first.nextOffset, 1);
		ok(first.text.includes("Continue with the same query at offset=1"), first.text);
		ok(first.text.includes("dropping query changes which rows it selects"), "it says why the query must be kept");
		ok(
			!first.text.includes('context(scope="skills", offset=1)'),
			"it never recommends a bare offset that would index the unfiltered set",
		);
	});

	it("visits every matching row exactly once when the continuation is followed", () => {
		const seen: string[] = [];
		let offset: number | undefined = 0;
		let guard = 0;
		while (offset !== undefined && guard < 20) {
			guard += 1;
			const view: ReturnType<typeof buildSkillCatalogView> = buildSkillCatalogView({
				...BASE,
				skills: catalog,
				capBytes: 50 * 1024,
				query: "git",
				limit: 1,
				offset,
			});
			seen.push(...view.rows.map((row) => row.name));
			offset = view.nextOffset;
		}
		strictEqual(offset, undefined, "paging terminated");
		strictEqual(seen.length, 2, "exactly the two matching rows");
		strictEqual(new Set(seen).size, 2, "and neither was repeated");
		ok(!seen.includes("alpha") && !seen.includes("beta"), "no non-matching row leaked in");
	});

	it("lists everything when a query carries no searchable terms", () => {
		const view = buildSkillCatalogView({ ...BASE, skills: catalog, capBytes: 50 * 1024, query: "?!?" });
		strictEqual(view.shown, 4, "inventory completeness is preserved rather than returning an empty page");
		strictEqual(view.filtered, false);
		ok(view.text.includes("no searchable terms"), view.text);
	});

	it("matches across Unicode composition forms", () => {
		strictEqual(lexicalMatches("café", "café workflow", "all"), true, "decomposed query, composed text");
		strictEqual(lexicalMatches("café", "café workflow", "all"), true, "composed query, decomposed text");
	});
});

describe("contracts/skills catalog drift identity", () => {
	it("marks drift from the typed set, never from the rendered line", () => {
		// A description that literally mentions the marker must not acquire a
		// drift footer; drift is a hash comparison, not a substring.
		const view = buildSkillCatalogView({
			...BASE,
			skills: [skill("honest", "Explains what a [drifted] skill is."), skill("real", "Ordinary.")],
			drifted: new Set(["real"]),
			capBytes: 50 * 1024,
		});
		strictEqual(view.driftedNames.length, 1);
		strictEqual(view.driftedNames[0], "real");
		ok(view.text.includes("Marked [drifted]: real no longer matches"), view.text.slice(-300));
		ok(!view.text.includes("- honest [drifted]"), "the honest row carries no marker");
	});

	it("agrees with the single-skill drift check on both authorities", () => {
		// The batch entry point exists so a listing reads the manifest once; it
		// must not become a second opinion.
		const subjects = [
			{ name: "no-record", normalizedHash: "a".repeat(64) },
			{
				name: "recorded-match",
				normalizedHash: "b".repeat(64),
				provenance: { installedHash: "b".repeat(64) },
			},
			{
				name: "recorded-mismatch",
				normalizedHash: "c".repeat(64),
				provenance: { installedHash: "d".repeat(64) },
			},
		];
		const batch = checkSkillDriftBatch(subjects, process.cwd());
		for (const subject of subjects) {
			const single = checkSkillDrift(subject, process.cwd());
			const fromBatch = batch.get(subject.name) ?? null;
			strictEqual(JSON.stringify(fromBatch), JSON.stringify(single), `${subject.name} must agree`);
		}
		strictEqual(batch.get("no-record"), undefined, "nothing recorded means no entry, not a null verdict");
		strictEqual(batch.get("recorded-match")?.authority, "install-record");
		strictEqual(batch.get("recorded-mismatch")?.verdict, "mismatch");
		strictEqual(checkSkillDriftBatch([], process.cwd()).size, 0);
	});
});

describe("contracts/skills catalog through the context tool", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	let cwd: string;

	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-skills-catalog-tool-");
		cwd = path.join(env.dir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		clearPluginSnapshots();
		env.restore();
	});

	/**
	 * A standalone skill package, installed the way the runtime expects: its
	 * package id and its skill share one name, which is the collision this
	 * suite exists to exercise.
	 */
	function installSkillPackage(id: string, description: string): void {
		installIntoBase(path.join(cwd, ".clio-coder", "plugins"), id, description);
	}

	function installIntoBase(base: string, id: string, description: string): void {
		const root = path.join(base, id);
		mkdirSync(root, { recursive: true });
		writeFileSync(
			path.join(root, "SKILL.md"),
			`---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody.\n`,
			"utf8",
		);
		writeFileSync(
			path.join(root, "plugin.json"),
			JSON.stringify({
				$schema: PLUGIN_SCHEMA,
				name: id,
				version: "1.0.0",
				description,
				license: "Apache-2.0",
				extensions: {
					"ai.iowarp.clio": {
						manifestVersion: 1,
						kind: "skill",
						resources: { skills: "." },
						components: [{ kind: "skill", id, path: "SKILL.md" }],
					},
				},
			}),
			"utf8",
		);
		const statePath = path.join(base, "state.json");
		const state = existsSync(statePath)
			? (JSON.parse(readFileSync(statePath, "utf8")) as {
					version: 1;
					disabled: string[];
					installed: Record<string, unknown>;
				})
			: { version: 1 as const, disabled: [], installed: {} };
		state.installed[id] = {
			installedAt: new Date().toISOString(),
			source: root,
			contentDigest: pluginContentDigest(root),
			kind: "skill",
			trust: "trusted",
		};
		writeFileSync(statePath, JSON.stringify(state), "utf8");
		clearPluginSnapshots();
	}

	function installUserSkillPackage(id: string, description: string): void {
		installIntoBase(path.join(configDir(), "plugins"), id, description);
	}

	it("shows exact drift hashes and a read-only review plus update preview path on load", async () => {
		const name = "drift-demo";
		const root = path.join(cwd, ".clio-coder", "skills", name);
		mkdirSync(root, { recursive: true });
		writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\n\n# Test\n`, "utf8");
		const pinRoot = path.join(cwd, "library", "skills");
		mkdirSync(pinRoot, { recursive: true });
		const expected = "a".repeat(64);
		writeFileSync(
			path.join(pinRoot, "registry.yaml"),
			`skills:\n  - name: ${name}\n    version: 1.0.0\n    sha256: ${expected}\n`,
			"utf8",
		);
		const installed = loadSkills({ cwd }).items.find((item) => item.name === name);
		ok(installed);
		const policy = withModelSkillActivation(undefined, true);
		ok(policy);
		const tool = createContextTool({ getCwd: () => cwd });
		const listed = await tool.run({ scope: "skills" });
		ok(listed.kind === "ok");
		ok(listed.output.includes("Load a named skill to compare recorded and installed hashes"));
		const loaded = await tool.run({ scope: "skills", name }, { pendingSkillPolicy: policy });
		ok(loaded.kind === "ok", JSON.stringify(loaded));
		ok(loaded.output.includes(`catalog sha256=${expected}`));
		ok(loaded.output.includes(`installed normalized sha256=${installed.normalizedHash}`));
		ok(loaded.output.includes(`clio-coder library recipes ${name} --kind skill --json`));
		ok(loaded.output.includes("clio-coder library update <owner-ref> --dry-run --json"));
		strictEqual(loaded.details?.driftExpectedHash, expected);
		strictEqual(loaded.details?.driftInstalledHash, installed.normalizedHash);
		const bound = agentSkillToolPolicy([name]);
		ok(bound);
		const recipeLoad = await tool.run({ scope: "skills", name }, { pendingSkillPolicy: bound });
		ok(recipeLoad.kind === "ok");
		strictEqual(skillActivationFromToolDetails(recipeLoad.details)?.requestSource, "recipe");
	});

	async function listing(args: Record<string, unknown> = {}) {
		const tool = createContextTool({ getCwd: () => cwd });
		const result = await tool.run({ scope: "skills", ...args }, {});
		ok(result.kind === "ok", JSON.stringify(result));
		return result;
	}

	it("keeps text and details on the same page when a ready row and a package row share a name", async () => {
		// An installed standalone skill produces both rows under one name.
		// Filtering details by name alone put the package row in `details` on a
		// page whose text carried only the ready row.
		installSkillPackage("probe-kit", "A probe skill package.");
		const full = await listing();
		const details = full.details as Record<string, unknown>;
		const skills = details.skills as Array<{ name: string }>;
		const packages = details.installedPackages as Array<{ name: string }>;
		ok(
			skills.some((entry) => entry.name === "probe-kit"),
			"the ready row is present unfiltered",
		);
		ok(
			packages.some((entry) => entry.name === "probe-kit"),
			"and so is the package row",
		);

		const paged = await listing({ limit: 1 });
		const pagedDetails = paged.details as Record<string, unknown>;
		const pagedSkills = pagedDetails.skills as Array<{ name: string }>;
		const pagedPackages = pagedDetails.installedPackages as Array<{ name: string }>;
		strictEqual(
			pagedSkills.length + pagedPackages.length,
			1,
			"one row on the page means one row in details, whatever the names collide on",
		);
		const text = paged.output ?? "";
		strictEqual(
			pagedPackages.length,
			text.includes("Installed packages providing skills") ? 1 : 0,
			"details reports the package row only when the text carries that section",
		);
	});

	it("narrows the listing through the tool's own query argument", async () => {
		installSkillPackage("probe-kit", "A probe skill package.");
		installSkillPackage("unrelated-kit", "Something else entirely.");
		const all = await listing();
		const narrowed = await listing({ query: "probe" });
		ok((narrowed.output ?? "").includes("probe-kit"));
		ok(!(narrowed.output ?? "").includes("unrelated-kit"), "the unmatched package is gone from the text");
		ok(B(narrowed.output ?? "") < B(all.output ?? ""), "and the response is smaller");
		const details = narrowed.details as Record<string, unknown>;
		strictEqual(details.query, "probe");
		ok(typeof details.totalSkills === "number", "details states the unfiltered totals beside the page");
	});

	it("keeps the query in the envelope continuation, not only in the body prose", async () => {
		// The body said "same query" while the envelope's own continuation carried
		// a bare offset, which indexes the unfiltered catalog.
		installSkillPackage("probe-kit", "A probe skill package.");
		installSkillPackage("probe-two", "Another probe skill package.");
		const filtered = await listing({ query: "probe", limit: 1 });
		const details = filtered.details as Record<string, unknown>;
		const observation = details.observation as Record<string, unknown> | undefined;
		const next = String(observation?.next ?? "");
		ok(next.includes("offset="), `envelope continuation is present: ${JSON.stringify(observation)}`);
		ok(next.includes("same query"), `envelope continuation keeps the query: ${next}`);

		const unfiltered = await listing({ limit: 1 });
		const plain = String(
			((unfiltered.details as Record<string, unknown>).observation as Record<string, unknown> | undefined)?.next ?? "",
		);
		ok(plain.includes("offset="), plain);
		ok(!plain.includes("same query"), "an unfiltered page says nothing about a query it did not have");
	});

	it("does not leak a same-id package installed at another scope into a page", async () => {
		// `installedSkillPackages` reads every scope, so one id can produce two
		// package rows. Selecting details by kind and name alone would put both on
		// a page that carried one.
		installSkillPackage("probe-kit", "A probe skill package.");
		installUserSkillPackage("probe-kit", "The same id, installed globally.");
		const full = await listing();
		const packages = (full.details as Record<string, unknown>).installedPackages as Array<{
			name: string;
			scope: string;
		}>;
		strictEqual(packages.length, 2, "both copies are listed unfiltered");
		strictEqual(new Set(packages.map((entry) => entry.scope)).size, 2, "and they are distinct scopes");

		const paged = await listing({ limit: 2 });
		const pagedPackages = (paged.details as Record<string, unknown>).installedPackages as Array<unknown>;
		const pagedSkills = (paged.details as Record<string, unknown>).skills as Array<unknown>;
		strictEqual(
			pagedSkills.length + pagedPackages.length,
			2,
			"details carries exactly the rows the page carried, whatever ids collide",
		);
	});

	it("keeps the reply protocol in the tool result", async () => {
		installSkillPackage("probe-kit", "A probe skill package.");
		const result = await listing();
		ok((result.output ?? "").includes("If one skill above matches"), "the protocol anchor reaches the caller");
	});

	it("lists no skill rows when discovery is off for the run", async () => {
		installSkillPackage("probe-kit", "A probe skill package.");
		const tool = createContextTool({
			getCwd: () => cwd,
			getSkillLoaderOptions: () => ({ disableDiscovery: true }),
		});
		const result = await tool.run({ scope: "skills" }, {});
		ok(result.kind === "ok", JSON.stringify(result));
		ok(!(result.output ?? "").includes("probe-kit"), "--no-skills still yields no skill rows");
	});

	it("offers no marketplace rows on a worker registry", async () => {
		const tool = createContextTool({ getCwd: () => cwd, skillMarketplace: false });
		const result = await tool.run({ scope: "skills" }, {});
		ok(result.kind === "ok", JSON.stringify(result));
		ok(!(result.output ?? "").includes("Marketplace ("), "a worker is offered no marketplace section");
	});
});
