import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { countFsCalls, installFsCounters } from "../harness/fs-counter.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Once boot commits a plugin generation, a listing outside a discovery pass
// re-verifies every installed plugin tree, and that walk is the integrity
// check: about 70 ms of blocked event loop with 52 installed plugins. These pin
// how many walks the operations an interactive session repeats may cost. A walk
// is measured rather than assumed. The integrity check fstats every file it
// hashes (src/domains/extensions/integrity.ts), so a walk is the fstatSync calls
// one listInstalledPlugins adds for the plugin set against a project holding
// none. Counting hashed files rather than every fs call keeps per-plugin
// parsing, such as reading each package's SKILL.md, out of the walk count.
// Counters are installed before any product module loads so their fs imports
// see the wrappers.
const home = mkdtempSync(join(tmpdir(), "clio-coder-plugin-walks-"));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
await installFsCounters();
const plugins = await import("../../src/domains/plugins/index.js");
const { createResourcesLoader } = await import("../../src/domains/resources/loader.js");
const { readLibraryInventory } = await import("../../src/domains/resources/library-inventory.js");
const { expandInteractiveSubmitAsync } = await import("../../src/interactive/interactive-application.js");
const { createSlashCommandAutocompleteProvider } = await import("../../src/interactive/slash-autocomplete.js");
const { createContextTool } = await import("../../src/tools/context/index.js");
const { discoverMarketplaceSkills, installedSkillNames, modelVisibleSkills } = await import(
	"../../src/domains/resources/index.js"
);
const { createMiddlewareBundle } = await import("../../src/domains/middleware/extension.js");
const { createMarketplaceOfferRegistration } = await import("../../src/domains/middleware/marketplace-offer.js");
const { createSkillsReminderRegistration } = await import("../../src/domains/middleware/skills-reminder.js");
const { createMiddlewareToolChoiceControl } = await import("../../src/domains/middleware/tool-choice-control.js");
const { createTurnMiddleware } = await import("../../src/interactive/turn-middleware.js");
const { createTurnState } = await import("../../src/interactive/turn-state.js");

const PLUGINS = 6;
const scratch: string[] = [home];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, text: string): void {
	const file = join(root, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/** A skill and a prompt template, the resources every listing below reads. */
function resourcePlugin(name: string): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-plugin-walks-source-"));
	scratch.push(root);
	write(root, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Walk fixture skill.\n---\nRead.\n`);
	for (let index = 0; index < 4; index++)
		write(root, `skills/${name}/references/note-${index}.md`, `Reference ${index} for ${name}.\n`);
	write(root, `prompts/${name}-run.md`, `---\ndescription: Walk fixture prompt.\n---\nRun ${name}.\n`);
	write(
		root,
		"plugin.json",
		JSON.stringify({
			$schema: plugins.PLUGIN_SCHEMA,
			name,
			version: "1.0.0",
			description: "Walk fixture",
			extensions: { "ai.iowarp.clio": { manifestVersion: 1, resources: { skills: "skills", prompts: "prompts" } } },
		}),
	);
	return root;
}

function project(count: number): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-plugin-walks-project-")));
	scratch.push(cwd);
	for (let index = 0; index < count; index++)
		ok(plugins.installPlugin(resourcePlugin(`walk-kit-${index}`), { cwd, scope: "project" }).plugin);
	return cwd;
}

/** Files `body` hashes in `cwd` after boot has committed a plugin generation. */
async function counted(cwd: string, body: (cwd: string) => unknown): Promise<number> {
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		plugins.clearPluginSnapshots();
		plugins.reloadPluginResources(cwd);
		// Let reload and install I/O drain so it cannot land inside the window.
		await new Promise((settle) => setImmediate(settle));
		await new Promise((settle) => setImmediate(settle));
		return (await countFsCalls(async () => await body(cwd))).byName["fs.fstatSync"] ?? 0;
	} finally {
		process.chdir(previous);
	}
}

interface Operation {
	readonly name: string;
	/** The ceiling. Lower it when an operation needs fewer walks. */
	readonly walks: number;
	run(cwd: string): unknown;
}

const signal = new AbortController().signal;

/**
 * A fresh session's first substantive turn_start, with the skills reminder and
 * the marketplace offer wired to the same listings the orchestrator gives them.
 */
function firstTurnStart(cwd: string): void {
	const resources = createResourcesLoader({ cwd });
	const { contract } = createMiddlewareBundle({
		registrations: [
			createSkillsReminderRegistration({
				countModelVisibleSkills: () => modelVisibleSkills(resources.skills(cwd).items).length,
				countInstallableSkills: () => {
					const installed = installedSkillNames(resources.skills(cwd).items, cwd);
					return discoverMarketplaceSkills({ cwd }).skills.filter((skill) => !installed.has(skill.name)).length;
				},
				modelMayActivateSkills: () => true,
			}),
			createMarketplaceOfferRegistration({
				listInstalledSkillNames: () => [...installedSkillNames(resources.skills(cwd).items, cwd)],
				listMarketplaceEntries: () => discoverMarketplaceSkills({ cwd }).skills,
				installEntry: () => {
					throw new Error("the walk fixture never installs");
				},
				declines: { readNever: () => ({}), recordNever: () => {} },
			}),
		],
	});
	const runtime = {
		wireModelId: "fixture",
		runtimeId: "fixture",
		runtimeResolution: {},
		agent: { state: { tools: [], messages: [] } },
	} as unknown as import("../../src/interactive/turn-state.js").AgentRuntime;
	createTurnMiddleware({
		state: createTurnState("off"),
		middleware: contract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: () => {},
	}).fireTurnStart(runtime, "fix the failing parser build and explain the regression");
}
const OPERATIONS: ReadonlyArray<Operation> = [
	{
		name: "submitting plain text",
		walks: 0,
		run: (cwd) => expandInteractiveSubmitAsync("summarize the failing build", createResourcesLoader({ cwd }), cwd),
	},
	{
		name: "submitting /skill",
		walks: 1,
		run: (cwd) => expandInteractiveSubmitAsync("/skill walk-kit-0 check the build", createResourcesLoader({ cwd }), cwd),
	},
	{
		name: "submitting a prompt template",
		walks: 1,
		run: (cwd) => expandInteractiveSubmitAsync("/walk-kit-0-run", createResourcesLoader({ cwd }), cwd),
	},
	{
		name: "context(scope=skills)",
		walks: 1,
		run: (cwd) => createContextTool({ getCwd: () => cwd }).run({ scope: "skills" }),
	},
	{
		name: "completing a slash command",
		walks: 1,
		run: (cwd) =>
			createSlashCommandAutocompleteProvider({
				fdPath: null,
				basePath: cwd,
				promptTemplates: () => createResourcesLoader({ cwd }).prompts(cwd).items,
			}).getSuggestions(["/walk"], 0, 5, { signal }),
	},
	{
		name: "a session's first turn_start",
		walks: 1,
		run: firstTurnStart,
	},
	{
		name: "reading the library inventory",
		walks: 1,
		run: (cwd) => readLibraryInventory({ cwd }),
	},
];

describe("plugin walks per repeated operation", () => {
	it("verifies each installed plugin tree at most once per operation", async () => {
		const baseline = project(0);
		const installed = project(PLUGINS);
		const walk = (cwd: string) => plugins.listInstalledPlugins(cwd, { all: true });
		// One uncounted round loads lazily imported modules and fills settings
		// caches, so each counted window measures the operation alone.
		for (const operation of [{ run: walk }, ...OPERATIONS]) {
			await counted(baseline, operation.run);
			await counted(installed, operation.run);
		}
		const perWalk = (await counted(installed, walk)) - (await counted(baseline, walk));
		// Each fixture plugin holds seven files. Fewer hashes means verification
		// stopped using fstatSync and this contract no longer measures walks.
		ok(perWalk >= PLUGINS * 7, `a walk over ${PLUGINS} plugins made only ${perWalk} fstatSync calls`);
		const measured: string[] = [];
		const over: string[] = [];
		for (const operation of OPERATIONS) {
			const walks = ((await counted(installed, operation.run)) - (await counted(baseline, operation.run))) / perWalk;
			measured.push(`${operation.name}: ${walks.toFixed(2)}`);
			if (walks > operation.walks) over.push(`${operation.name} (${walks.toFixed(2)} > ${operation.walks})`);
		}
		ok(over.length === 0, `walks above ceiling: ${over.join("; ")}. Measured ${measured.join("; ")}`);
	});
});
