import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { runBootstrap } from "../../src/domains/context/bootstrap.js";
import {
	BOOTSTRAP_INPUT_MAX_CHARS,
	buildBootstrapPrompt,
	parseBootstrapModelOutput,
} from "../../src/domains/context/bootstrap-prompt.js";
import { parseClioMd, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { fitGeneratedHandbook, normalizeHandbookRule } from "../../src/domains/context/handbook-budget.js";
import { resolveToolBudgetEnvelope } from "../../src/domains/dispatch/budget-envelope.js";
import { resolveDeliveryTools } from "../../src/engine/loop-guard.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { createContextActivityStore, formatContextActivityRailLines } from "../../src/interactive/context-activity.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("bounds the model input even when the enforcement inventory alone exceeds the input budget", () => {
	const prompt = buildBootstrapPrompt({
		cwd: ".",
		projectType: "typescript",
		expectedProjectName: "Fixture",
		siblingFiles: [],
		adoption: {
			cwd: ".",
			homeDir: ".",
			includeGlobal: false,
			sources: [],
			rejected: [],
			importedRules: [],
			conflicts: [],
			sourceHash: "",
			sourceSnapshots: [],
		},
		enforcement: {
			ciCommands: Array.from({ length: 60 }, () => "pnpm run check".repeat(100)),
			scripts: Object.fromEntries(
				Array.from({ length: 60 }, (_, index) => [`check:${index}`, "node scripts/check.js".repeat(100)]),
			),
			checkFiles: Array.from({ length: 24 }, (_, index) => ({
				path: `scripts/check-${index}.ts`,
				checks: ["checkRules"],
				failures: Array.from({ length: 40 }, (_, code) => `R${code}: ${"remedy ".repeat(500)}`),
			})),
		},
	});
	const serialized = prompt.split("<bootstrap-input>\n")[1]?.split("\n</bootstrap-input>")[0];
	assert.ok(serialized);
	assert.ok(serialized.length <= BOOTSTRAP_INPUT_MAX_CHARS);
	assert.equal(JSON.parse(serialized).expectedProjectName, "Fixture");
});

it("fits whole change recipes under 200 lines while retaining the verification gate", () => {
	const result = fitGeneratedHandbook({
		projectName: "Fixture",
		identity: "A fixture.",
		invariants: ["Preserve `src/index.ts`."],
		conventions: [],
		sections: [
			{
				title: "Change recipes",
				body: Array.from(
					{ length: 150 },
					(_, index) =>
						`- Change ${index} in \`src/index.ts\`.\n  - Update the matching test.\n  - Keep the documented remedy.`,
				).join("\n"),
			},
			{ title: "Verification expectations", body: "Run `npm test`." },
		],
	});
	const text = serializeClioMd(result);
	assert.ok(text.trimEnd().split("\n").length <= 200);
	assert.ok(text.length <= 24_000);
	assert.match(text, /Run `npm test`/);
	assert.ok(parseClioMd(text).ok);
	const recipe = result.sections?.find((section) => section.title === "Change recipes")?.body ?? "";
	assert.ok(recipe.endsWith("Keep the documented remedy."), "the final retained recipe must contain all its steps");
});

it("keeps whole parser recipes and deduplicates prose without conflating code operators", () => {
	const output = parseBootstrapModelOutput(
		JSON.stringify({
			projectName: "Fixture",
			identity: "Fixture.",
			invariants: [],
			conventions: [],
			sections: [
				{ title: "Recipes", body: `- Keep \`src/a.ts\`.\n  - Keep its test.\n\n- ${"Oversized recipe ".repeat(500)}` },
			],
		}),
	);
	assert.equal(output.sections?.[0]?.body, "- Keep `src/a.ts`.\n  - Keep its test.");
	assert.notEqual(normalizeHandbookRule("Use `x !== undefined`."), normalizeHandbookRule("Use `x === undefined`."));
	assert.notEqual(normalizeHandbookRule("Read `src/*`."), normalizeHandbookRule("Read `src/**`."));
	const fitted = fitGeneratedHandbook({
		projectName: "Fixture",
		identity: "Fixture.",
		invariants: ["Only `src/engine/**` imports the SDK; keep the boundary."],
		conventions: [],
		sections: [
			{
				title: "Authored project rules",
				body: "- Only `src/engine/**` imports the SDK. Keep the boundary. (source: CLAUDE.md)",
			},
		],
	});
	assert.equal(serializeClioMd(fitted).match(/Only /g)?.length, 1);
});

it("stage completion stays active; only operation completion closes the dock progress", () => {
	const bus = createSafeEventBus();
	const store = createContextActivityStore(bus);
	bus.emit(BusChannels.ContextActivity, {
		kind: "context-init",
		phase: "scan",
		status: "started",
		message: "Scanning",
		at: 100,
	});
	bus.emit(BusChannels.ContextActivity, {
		kind: "context-init",
		phase: "codewiki",
		status: "completed",
		message: "Indexed",
		at: 200,
		current: 100,
		total: 100,
	});
	assert.equal(store.current(201)?.completedAtMs, null);
	assert.equal(store.active(10_000), true);
	const activity = store.current(201);
	assert.ok(activity);
	bus.emit(BusChannels.ContextActivity, { ...activity, at: 201, message: null } as never);
	assert.equal(store.current(202)?.message, "Indexed", "malformed process events must not break rail rendering");
	for (const width of [1, 8, 20, 60, 80, 120, 200]) {
		const lines = formatContextActivityRailLines(activity, width, 201);
		assert.equal(lines.length, 3);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`${width} columns`,
		);
	}
	bus.emit(BusChannels.ContextActivity, {
		kind: "context-init",
		phase: "done",
		status: "completed",
		message: "Ready",
		at: 300,
	});
	assert.equal(store.current(301)?.completedAtMs, 300);
	assert.equal(store.active(10_000), false);
	store.unsubscribe();
});

it("bootstrap navigation cannot bypass the exploration budget as an orientation delivery tool", () => {
	const recipe = loadRecipesFromDir({
		source: "builtin",
		dir: join(import.meta.dirname, "../../src/domains/agents/builtins"),
	}).find((entry) => entry.id === "context-bootstrap");
	assert.ok(recipe);
	assert.deepEqual(resolveDeliveryTools(recipe.tools, recipe.product), []);
});

it("enforces the bootstrap exploration allowance instead of the general scout allowance", () => {
	const envelope = resolveToolBudgetEnvelope({
		recipeId: "context-bootstrap",
		policy: { toolCalls: 40, readReserve: 8, synthesis: true },
		request: { toolCalls: 8, readReserve: 3 },
		hardCap: 150,
		hasReadTool: true,
		retry: false,
		revision: false,
		nativeReadOnlyResearch: true,
	});
	assert.equal(envelope.effective.mode, "enforced");
	assert.equal(envelope.effective.toolCalls, 8);
});

it("retains an authored preservation rule omitted by the model and emits a terminal preview event", async () => {
	const isolated = await isolateClioEnv("context-authored-");
	try {
		const cwd = join(isolated.dir, "repo");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), '{"name":"harbor","scripts":{"test":"node --test"}}');
		writeFileSync(
			join(cwd, ".claude/CLAUDE.md"),
			"# Harbor\n\nPreserve the original sample IDs. Never sort samples.\n\n" +
				"## Change recipes\n\n- Removed settings key: record it in `package.json`. Do not just delete it.\n" +
				"\n## Development sessions: default scope\n\n- Ask the user before running release commands. Wait for approval.\n",
		);
		const result = await runBootstrap({
			cwd,
			generate: async (input) => {
				input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
				return {
					projectName: "Harbor",
					identity: "A harbor.",
					invariants: [],
					conventions: [],
					sections: [{ title: "Tests", body: "Run `npm test` before changing `package.json`." }],
				};
			},
		});
		const text = readFileSync(result.clioMdPath, "utf8");
		assert.match(text, /Preserve the original sample IDs/);
		assert.match(text, /Never sort samples/);
		assert.match(text, /Removed settings key: record it in `package.json`\. Do not just delete it\./);
		assert.ok(!text.includes("- Do not just delete it."), "retain the subject with the prohibition");
		assert.match(text, /## Operating instructions from project handbooks/);
		assert.match(text, /Ask the user before running release commands\. Wait for approval\./);
		const phases: string[] = [];
		await runBootstrap({ cwd, preview: true, onProgress: (event) => phases.push(`${event.phase}:${event.status}`) });
		assert.equal(phases.at(-1), "done:completed");
	} finally {
		await isolated.restore();
	}
});

it("saves a proposal when a concurrent edit changes the handbook during generation", async () => {
	const isolated = await isolateClioEnv("context-concurrent-handbook-");
	try {
		const cwd = join(isolated.dir, "repo");
		mkdirSync(cwd);
		const handbook = join(cwd, "CLIO-CODER.md");
		writeFileSync(handbook, "# Harbor\n\nOriginal instructions.\n");
		const edited = "# Harbor\n\nA concurrent human edit.\n";
		const result = await runBootstrap({
			cwd,
			applyClioMd: true,
			generate: async () => {
				writeFileSync(handbook, edited);
				return { projectName: "Harbor", identity: "A draft.", invariants: [], conventions: [] };
			},
		});
		assert.equal(result.summary.action, "proposed");
		assert.equal(readFileSync(handbook, "utf8"), edited);
		assert.ok(result.summary.proposalPath);
	} finally {
		await isolated.restore();
	}
});

it("a failed rewrite preserves the exact authored handbook bytes", async () => {
	const isolated = await isolateClioEnv("context-failed-rewrite-");
	try {
		const cwd = join(isolated.dir, "repo");
		mkdirSync(cwd);
		const text = "# Harbor\n\nA harbor.\n\n## Human policy\n\nKeep these   exact spaces.\n";
		writeFileSync(join(cwd, "CLIO-CODER.md"), text);
		const result = await runBootstrap({
			cwd,
			rewriteClioMd: true,
			generate: async (input) => {
				input.reportGeneration?.({ mode: "existing", parserOutcome: "not-run", fallbackReason: "offline" });
				return { projectName: "Harbor", identity: "A harbor.", invariants: [], conventions: [], sections: [] };
			},
		});
		assert.equal(result.summary.action, "preserved");
		assert.equal(readFileSync(join(cwd, "CLIO-CODER.md"), "utf8"), text);
	} finally {
		await isolated.restore();
	}
});
