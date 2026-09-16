import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureGuardrails } from "../../src/core/guardrails.js";
import { installPlugin, pluginContentDigest } from "../../src/domains/plugins/index.js";
import { readLibraryInventory } from "../../src/domains/resources/library-inventory.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createClioLibraryTool } from "../../src/tools/gateway/clio-context-tools.js";
import type { ToolInvokeOptions } from "../../src/tools/registry.js";

/**
 * clio_library, the gateway capability that took over context(scope="library"),
 * is a bounded, body-free READ over the shared inventory. These contracts hold
 * it to that: real Materio identities, honest ownership and origin, stable
 * pages, budget reserved before any discovery, no mutation, no source fetch,
 * no internal agents, and no library at all for a native worker. The last
 * contract pins the context tool's own refusal of the moved scope.
 */

const materioSource = fileURLToPath(new URL("../../library/plugins/materio/", import.meta.url));
const roots: string[] = [];

function scratch(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "clio-coder-library-context-"));
	roots.push(directory);
	return directory;
}

function withMaterio(): string {
	const project = scratch();
	const result = installPlugin(materioSource, {
		cwd: project,
		scope: "project",
		expectedDigest: pluginContentDigest(materioSource),
		expectedId: "materio",
	});
	ok(result.plugin?.loadable, JSON.stringify(result.diagnostics));
	return project;
}

interface LibraryRow {
	row: "resource" | "hint" | "package";
	kind: string;
	name: string;
	key?: string;
	owner?: string;
	ref?: string;
	scope?: string;
	origin: { kind: string } & Record<string, unknown>;
	invocation?: string;
	installed?: Array<{ scope: string; state: string }>;
	ownerInstalled?: Array<{ scope: string; state: string }>;
	member?: string;
	provides?: string[] | string;
	availability?: string;
}

interface LibraryPayload {
	scope: string;
	total: number;
	shown: number;
	offset: number;
	nextOffset?: number;
	rows: LibraryRow[];
	note: string;
	diagnostics?: string[];
}

function libraryTool(cwd: string, deps: Record<string, unknown> = {}) {
	return createClioLibraryTool({ getCwd: () => cwd, ...deps });
}

async function read(
	cwd: string,
	args: Record<string, unknown> = {},
	options: ToolInvokeOptions = {},
): Promise<LibraryPayload> {
	const result = await libraryTool(cwd).run({ ...args }, options);
	strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "expected an ok read");
	if (result.kind !== "ok") throw new Error("unreachable");
	const payload = JSON.parse(result.output) as LibraryPayload;
	ok(Array.isArray(payload.rows), `expected a row page, got ${result.output.slice(0, 400)}`);
	return payload;
}

/** Walk every page the way a caller following nextOffset would. */
async function collect(cwd: string, args: Record<string, unknown> = {}): Promise<LibraryRow[]> {
	const rows: LibraryRow[] = [];
	let offset = 0;
	for (;;) {
		const page = await read(cwd, { ...args, limit: 50, offset });
		rows.push(...page.rows);
		if (page.nextOffset === undefined) break;
		offset = page.nextOffset;
		ok(rows.length <= page.total, "pages returned more rows than the reported total");
	}
	return rows;
}

function ownedBy(rows: ReadonlyArray<LibraryRow>, owner: string, kind: string): LibraryRow[] {
	return rows.filter((row) => row.row === "resource" && row.owner === owner && row.kind === kind);
}

function listTree(root: string): string[] {
	try {
		return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
	} catch {
		return [];
	}
}

describe("clio_library (the former context library scope)", () => {
	afterEach(() => {
		configureGuardrails(undefined);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("projects every Materio recipe with its actual runtime name, owner and invocation", async () => {
		const project = withMaterio();
		const rows = await collect(project);

		const skills = ownedBy(rows, "plugin:materio", "skill");
		const agents = ownedBy(rows, "plugin:materio", "agent");
		const prompts = ownedBy(rows, "plugin:materio", "prompt");
		const fleets = ownedBy(rows, "plugin:materio", "fleet");
		strictEqual(skills.length, 6, skills.map((row) => row.name).join(", "));
		strictEqual(agents.length, 6, agents.map((row) => row.name).join(", "));
		strictEqual(prompts.length, 17, prompts.map((row) => row.name).join(", "));
		strictEqual(fleets.length, 1, fleets.map((row) => row.name).join(", "));

		// Runtime names, not component ids: the manifest declares `lab-definer`
		// and the loader answers to `materio-lab-definer`.
		ok(
			skills.some((row) => row.name === "materio-lab-definer"),
			"skill rows must carry the loader's frontmatter name",
		);
		ok(
			agents.some((row) => row.name === "materio-lab-definer"),
			"agent rows must carry the recipe file id",
		);
		ok(
			prompts.every((row) => row.name.startsWith("materio:")),
			"prompt rows must carry the colon path name",
		);
		strictEqual(fleets[0]?.name, "materio-execute-task");
		for (const row of [...skills, ...agents, ...prompts, ...fleets]) {
			ok(row.invocation, `${row.kind}:${row.name} is listed as usable and must say how it is invoked`);
			strictEqual(row.scope, "package");
		}
		ok(
			skills.every((row) => row.invocation?.startsWith("/skill ")),
			"a skill's invocation is the operator's /skill route",
		);
	});

	it("carries origin evidence separately from scope and format", async () => {
		const project = withMaterio();
		const rows = await collect(project, { kind: "skill" });
		const materio = ownedBy(rows, "plugin:materio", "skill")[0];
		ok(materio, "materio must contribute skill rows");
		ok(materio.origin, "every row must carry origin evidence");
		ok(
			["bundled", "local", "remote", "imported", "core", "unknown"].includes(materio.origin.kind),
			`unexpected origin class ${materio.origin.kind}`,
		);
		// Origin, scope and owner are three separate facts and none of them may
		// be inferred from another.
		strictEqual(materio.scope, "package");
		strictEqual(materio.owner, "plugin:materio");
	});

	it("finds the owning bundle by a recipe kind before it is installed, without fetching it", async () => {
		const project = scratch();
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: unknown) => {
			fetched.push(String(input));
			throw new Error("a library read must never fetch a package source");
		}) as typeof globalThis.fetch;
		try {
			const rows = await collect(project, { kind: "agent" });
			const materio = rows.find((row) => row.row === "package" && row.ref === "plugin:materio");
			ok(materio, "an agent-kind query must surface the package that provides agents");
			strictEqual(materio.installed?.length, 0, "the package is not installed in this workspace");
			ok(Array.isArray(materio.provides), "a curated package must publish bounded provides hints");
			ok(
				(materio.provides as string[]).some((hint) => hint.startsWith("agent:")),
				"the hint list must name the agents that matched the query",
			);

			const hints = rows.filter((row) => row.row === "hint" && row.owner === "plugin:materio");
			ok(hints.length > 0, "the member-level catalog hints must be listed as their own rows");
			for (const hint of hints) {
				strictEqual(hint.kind, "agent");
				strictEqual(hint.member, "not-installed", "an uninstalled owner makes its members uninstalled");
				strictEqual(hint.ownerInstalled?.length, 0);
				strictEqual(hint.invocation, undefined, "a catalog hint has nothing to invoke");
			}
		} finally {
			globalThis.fetch = realFetch;
		}
		strictEqual(fetched.length, 0, `library read fetched ${fetched.join(", ")}`);
	});

	it("drops a hint once its real resource is on the page and never claims an unknown member is uninstalled", async () => {
		const project = withMaterio();
		const rows = await collect(project, { kind: "agent" });
		const actual = ownedBy(rows, "plugin:materio", "agent").map((row) => row.name);
		ok(actual.length > 0, "the installed copy must contribute real agent rows");
		const hints = rows.filter((row) => row.row === "hint" && row.owner === "plugin:materio");
		for (const hint of hints) {
			ok(!actual.includes(hint.name), `hint ${hint.name} duplicates a loaded resource`);
			// The owner is installed here, so a member this read did not see is
			// unknown, never "not-installed".
			strictEqual(hint.member, "unknown");
			ok(
				hint.ownerInstalled?.some((copy) => copy.scope === "project"),
				"an installed owner must report its real copy state on the hint",
			);
		}
	});

	it("separates installable package rows from usable recipe rows", async () => {
		const project = withMaterio();
		const packages = await collect(project, { kind: "plugin" });
		ok(packages.length > 0, "the bundled catalog must produce package rows");
		ok(
			packages.every((row) => row.row === "package"),
			"kind=plugin is the package view and must not mix in recipes",
		);
		const materio = packages.find((row) => row.ref === "plugin:materio");
		ok(materio, "materio must appear as an install target");
		const installedCopy = materio.installed?.find((copy) => copy.scope === "project");
		ok(installedCopy, "the installed project copy must be reported on the package row");
		// The declared LibraryCopyState vocabulary. `loadable` is a package-root
		// gate, not proof that any particular member was admitted, which is why a
		// hint row still reports its member state separately.
		ok(
			["loadable", "disabled", "shadowed", "invalid", "incompatible", "damaged"].includes(installedCopy.state),
			`copy state "${installedCopy.state}" is outside LibraryCopyState`,
		);
		strictEqual(installedCopy.state, "loadable");

		const recipes = await collect(project, { kind: "fleet" });
		ok(
			recipes.some((row) => row.row === "resource" && row.kind === "fleet"),
			"a recipe-kind query must return the actual fleet resources",
		);
	});

	it("selects one record by ref and reports an honest empty match", async () => {
		const project = withMaterio();
		const exact = await read(project, { ref: "plugin:materio", kind: "plugin" });
		strictEqual(exact.rows.length, 1);
		strictEqual(exact.rows[0]?.ref, "plugin:materio");

		const missing = await read(project, { ref: "plugin:no-such-package" });
		strictEqual(missing.total, 0);
		strictEqual(missing.rows.length, 0);
		ok(missing.note.includes("Nothing matched"), missing.note);
	});

	it("selects an exact resource key without dragging in its owner's other members", async () => {
		const project = withMaterio();
		const inventory = readLibraryInventory({
			cwd: project,
			audience: "model",
			kinds: ["agent"],
			include: { packages: false, copies: false, resources: true },
		});
		const target = inventory.resources.find((resource) => resource.owner?.ref === "plugin:materio");
		ok(target, "materio must contribute an agent resource to key against");
		const payload = await read(project, { ref: target.key });
		const resources = payload.rows.filter((row) => row.row === "resource");
		strictEqual(resources.length, 1, JSON.stringify(payload.rows.map((row) => `${row.row}:${row.name}`)));
		strictEqual(resources[0]?.name, target.name);
		strictEqual(
			payload.rows.filter((row) => row.row === "hint").length,
			0,
			"an exact resource key must not expand its owner's catalog hints",
		);
	});

	it("reports an ambiguous bare name as several keyed records", async () => {
		const project = withMaterio();
		// Materio ships a skill and an agent under the same runtime name, which is
		// exactly the case a bare ref cannot resolve on its own.
		const payload = await read(project, { ref: "materio-lab-definer" });
		const resources = payload.rows.filter((row) => row.row === "resource");
		ok(resources.length > 1, JSON.stringify(resources.map((row) => `${row.kind}:${row.name}`)));
		strictEqual(new Set(resources.map((row) => row.kind)).size, resources.length, "each match is a distinct kind");
		ok(payload.note.includes("matched several records"), payload.note);
	});

	it("keeps a page inside a nearly spent reservation instead of returning a stub", async () => {
		const project = withMaterio();
		configureGuardrails({ observationTurnBudgetBytes: 1500 });
		const result = await libraryTool(project).run({ limit: 50 }, { sessionId: "library-context", turnId: "tiny" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		const payload = JSON.parse(result.output) as LibraryPayload;
		ok(Array.isArray(payload.rows), `expected a row page, got ${result.output.slice(0, 300)}`);
		ok(payload.rows.length <= 2, `a 1.5KB turn pool must not carry a full page, got ${payload.rows.length}`);
		if (payload.rows.length === 0) {
			strictEqual(payload.nextOffset, undefined, "an empty page must not offer the offset it was given");
			ok(payload.note.includes("observation budget"), payload.note);
		} else {
			ok(payload.nextOffset === undefined || payload.nextOffset > payload.offset, "the offset must advance");
		}
	});

	it("pages a stable total order without repeating or skipping a row", async () => {
		const project = withMaterio();
		const whole = await read(project, { limit: 50, offset: 0 });
		const first = await read(project, { limit: 3, offset: 0 });
		const second = await read(project, { limit: 3, offset: 3 });
		strictEqual(first.rows.length, 3);
		strictEqual(first.nextOffset, 3);
		strictEqual(second.offset, 3);
		const paged = [...first.rows, ...second.rows].map((row) => `${row.kind}:${row.name}`);
		const direct = whole.rows.slice(0, 6).map((row) => `${row.kind}:${row.name}`);
		strictEqual(paged.join("|"), direct.join("|"));
		strictEqual(new Set(paged).size, paged.length, "a page boundary repeated a row");
		strictEqual(first.total, second.total, "the total must not move between pages");
	});

	it("clamps the page size and never returns an unbounded listing", async () => {
		const project = withMaterio();
		const huge = await read(project, { limit: 5000 });
		ok(huge.rows.length <= 50, `expected the page cap to hold, got ${huge.rows.length}`);
		const negative = await read(project, { limit: -4, offset: -9 });
		strictEqual(negative.offset, 0);
		ok(negative.rows.length >= 1);
	});

	it("spends the observation budget before it walks the inventory", async () => {
		const project = withMaterio();
		configureGuardrails({ observationTurnBudgetBytes: 1024 });
		const options: ToolInvokeOptions = { sessionId: "library-context", turnId: "turn-1" };
		const first = await libraryTool(project).run({ limit: 5 }, options);
		strictEqual(first.kind, "ok");

		// The second call must short-circuit on the exhausted pool. A cwd getter
		// that throws proves the handler was never reached: if discovery ran, the
		// result would be the inventory error instead of the budget notice.
		const guarded = createClioLibraryTool({
			getCwd: () => {
				throw new Error("inventory reached despite an exhausted observation pool");
			},
		});
		const second = await guarded.run({}, options);
		strictEqual(second.kind, "ok");
		if (second.kind !== "ok") throw new Error("unreachable");
		ok(!second.output.includes("inventory reached"), second.output);
		ok(/budget/i.test(second.output), second.output);
	});

	it("returns no instruction bodies and writes nothing", async () => {
		const project = withMaterio();
		const before = listTree(path.join(project, ".clio-coder"));
		const rows = await collect(project);
		const rendered = JSON.stringify(rows);
		// A phrase from a Materio skill body. Descriptions are metadata; bodies
		// are not, and this projection must never carry one.
		ok(!rendered.includes("Interview the researcher about actual experimental"), "a library row leaked a skill body");
		ok(!rendered.includes("${component:"), "a library row leaked an unresolved package reference");
		const after = listTree(path.join(project, ".clio-coder"));
		strictEqual(after.join("|"), before.join("|"), "a read-only scope changed installed state");
	});

	it("hides internal and shadow agents from the model projection", async () => {
		const project = withMaterio();
		const rows = await collect(project, { kind: "agent" });
		const names = new Set(rows.filter((row) => row.row === "resource").map((row) => row.name));
		for (const internal of ["scout", "provenance", "researcher", "world-knowledge"]) {
			ok(!names.has(internal), `internal agent ${internal} must stay out of the model's library view`);
		}
		const inventory = readLibraryInventory({ cwd: project, audience: "operator", all: true, kinds: ["agent"] });
		ok(
			inventory.resources.some((resource) => resource.audience === "shadow" || resource.audience === "internal"),
			"the operator inventory must still carry the internal recipes this projection hides",
		);
	});

	it("refuses the read in a native worker registry", async () => {
		const project = withMaterio();
		const worker = createClioLibraryTool({ getCwd: () => project, skillMarketplace: false });
		const result = await worker.run({}, {});
		strictEqual(result.kind, "error");
		if (result.kind !== "error") throw new Error("unreachable");
		ok(result.message.includes("unavailable"), result.message);
		ok(!result.message.includes("plugin:materio"), "the refusal must not leak the library it refuses");
	});

	it("omits skill rows when the run has skill discovery switched off", async () => {
		const project = withMaterio();
		const rows = await collect(project);
		ok(ownedBy(rows, "plugin:materio", "skill").length > 0, "the ordinary run lists skills");
		const quiet = createClioLibraryTool({
			getCwd: () => project,
			getSkillLoaderOptions: () => ({ disableDiscovery: true, trustProjectCompatRoots: false }),
		});
		const result = await quiet.run({ limit: 50 }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		const payload = JSON.parse(result.output) as LibraryPayload;
		ok(
			payload.rows.every((row) => !(row.row === "resource" && row.kind === "skill")),
			"a --no-skills run must not advertise skills it cannot load",
		);
		ok(payload.note.includes("Skill discovery is off"), payload.note);
	});

	it("agrees with the shared inventory the CLI reads", async () => {
		const project = withMaterio();
		const rows = await collect(project, { kind: "prompt" });
		const inventory = readLibraryInventory({
			cwd: project,
			audience: "model",
			kinds: ["prompt"],
			include: { packages: false, copies: false, resources: true },
		});
		const projected = rows
			.filter((row) => row.row === "resource")
			.map((row) => `${row.kind}:${row.name}:${row.owner}:${row.invocation ?? ""}`)
			.sort();
		const direct = inventory.resources
			.map(
				(resource) =>
					`${resource.kind}:${resource.name}:${resource.owner ? resource.owner.ref : resource.source.class}:${resource.invocation ?? ""}`,
			)
			.sort();
		strictEqual(projected.join("|"), direct.join("|"));
	});

	it("leaves the remaining context scopes intact and points the moved scope at the gateway", async () => {
		const project = withMaterio();
		const context = createContextTool({ getCwd: () => project });
		const unknown = await context.run({ scope: "packages" }, {});
		strictEqual(unknown.kind, "error");
		if (unknown.kind !== "error") throw new Error("unreachable");
		ok(unknown.message.includes("workspace, skills, or recall"), unknown.message);

		const moved = await context.run({ scope: "library" }, {});
		strictEqual(moved.kind, "error");
		if (moved.kind !== "error") throw new Error("unreachable");
		ok(moved.message.includes('capability="clio_library"'), moved.message);
		ok(moved.message.includes("gateway("), moved.message);

		const skills = await context.run({ scope: "skills" }, {});
		strictEqual(skills.kind, "ok");
		if (skills.kind !== "ok") throw new Error("unreachable");
		ok(skills.output.includes("Available skills."), skills.output.slice(0, 200));
	});
});
