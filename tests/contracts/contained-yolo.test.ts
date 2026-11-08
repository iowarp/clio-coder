import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, recordYoloConfinementOnce, settingsPath } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { renderSessionPostureUpdate } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { admissionAutonomy, effectiveYoloConfinement } from "../../src/domains/safety/autonomy.js";
import { createSafetyJudge, type SafetyJudgeConfig } from "../../src/domains/safety/safety-judge.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import {
	createYoloActivation,
	YOLO_UNCONFINED_ACCEPT_LABEL,
	YOLO_UNCONFINED_DECLINE_LABEL,
} from "../../src/interactive/yolo-activation.js";
import { createRegistry, type PermissionRequiredMeta, type ToolSpec } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const CONFIG: SafetyJudgeConfig = { enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] };
const UNRECOGNIZED = "./scripts/sync-assets --all";

/**
 * The operator's main-session registry at contained yolo, wired as the
 * orchestrator wires it: admission at `default`, and asks never parked.
 */
function containedRegistry(reply: () => string) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-contained-yolo-")));
	let judged = 0;
	const judge = createSafetyJudge({
		config: () => CONFIG,
		complete: async () => {
			judged += 1;
			return { text: reply() };
		},
		operatorMessages: () => ["sync the assets"],
		session: () => "session-1",
		consequences: () => [],
	});
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => admissionAutonomy("yolo", "contained"),
		safetyJudge: judge,
		unattendedAsks: () => true,
	});
	const ran: string[] = [];
	const tool = (name: ToolSpec["name"], extra: Partial<ToolSpec> = {}): ToolSpec => ({
		name,
		description: `fake ${name}`,
		parameters: {} as ToolSpec["parameters"],
		baseActionClass: "execute",
		async run(args) {
			ran.push(String(args.command ?? name));
			return { kind: "ok", output: "ran" };
		},
		...extra,
	});
	registry.register(tool(ToolNames.Bash));
	registry.register(
		tool(ToolNames.ConfigureClio, { baseActionClass: "write", confirmationRuleId: "fleet-routing-settings" }),
	);
	const parks: PermissionRequiredMeta[] = [];
	registry.onPermissionRequired((_call, _decision, meta) => parks.push(meta));
	return { registry, ran, parks, judged: () => judged };
}

test("confinement resolves to contained unless unconfined is both chosen and accepted", () => {
	const safety = DEFAULT_SETTINGS.safety;
	strictEqual(effectiveYoloConfinement(safety), "contained");
	strictEqual(effectiveYoloConfinement({ ...safety, yoloConfinement: "unconfined" }), "contained");
	strictEqual(
		effectiveYoloConfinement({ ...safety, yoloConfinement: "unconfined", yoloUnconfinedAccepted: true }),
		"unconfined",
	);
	strictEqual(admissionAutonomy("yolo", "contained"), "default");
	strictEqual(admissionAutonomy("yolo", "unconfined"), "yolo");
	strictEqual(admissionAutonomy("default", "unconfined"), "default");
});

test("contained yolo runs what the judge allows and refuses what it blocks", async () => {
	const allowed = containedRegistry(() => JSON.stringify({ verdict: "allow", rule: "operator-named", reason: "asked" }));
	strictEqual((await allowed.registry.invoke({ tool: ToolNames.Bash, args: { command: UNRECOGNIZED } })).kind, "ok");
	deepStrictEqual(allowed.ran, [UNRECOGNIZED]);

	const blocked = containedRegistry(() => JSON.stringify({ verdict: "block", rule: "publish", reason: "uploads" }));
	const verdict = await blocked.registry.invoke({ tool: ToolNames.Bash, args: { command: UNRECOGNIZED } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind === "blocked") strictEqual(verdict.denial?.code, "safety-judge:publish");
	deepStrictEqual([blocked.ran, blocked.parks.length], [[], 0]);
});

test("contained yolo refuses a call the judge left without a verdict instead of parking it, and remembers it", async () => {
	const { registry, ran, parks, judged } = containedRegistry(() => "I am not sure.");
	const call = { tool: ToolNames.Bash, args: { command: UNRECOGNIZED } };
	const first = await registry.invoke(call, { turnId: "turn-1" });
	strictEqual(first.kind, "blocked");
	if (first.kind !== "blocked") return;
	match(first.reason, /contained yolo runs without the operator/u);
	match(first.reason, /Do not retry it/u);
	match(first.denial?.allowedBy ?? "", /contained yolo never waits/u);
	deepStrictEqual([ran, parks.length, judged()], [[], 0, 1]);

	const repeat = await registry.invoke(call, { turnId: "turn-1" });
	strictEqual(repeat.kind, "blocked");
	if (repeat.kind === "blocked") strictEqual(repeat.decision.policy?.reasonCode, "denied_repeat");
	deepStrictEqual([ran, parks.length, judged()], [[], 0, 1]);
});

test("contained yolo refuses an operator-only ask without the judge or a card", async () => {
	const { registry, ran, parks, judged } = containedRegistry(() =>
		JSON.stringify({ verdict: "allow", rule: "x", reason: "y" }),
	);
	const verdict = await registry.invoke({ tool: ToolNames.ConfigureClio, args: { action: "apply", proposalId: "p" } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind === "blocked") match(verdict.reason, /contained yolo runs without the operator/u);
	deepStrictEqual([ran, parks.length, judged()], [[], 0, 0]);
});

test("the unconfined prompt body appears only at effective unconfined yolo", () => {
	const table = loadFragments();
	const contained = renderSessionPostureUpdate(table, "yolo", { coordinatorCapabilities: [] });
	const unconfined = renderSessionPostureUpdate(table, "yolo", {
		coordinatorCapabilities: [],
		yoloConfinement: "unconfined",
	});
	match(contained, /Yolo is contained/u);
	doesNotMatch(contained, /Yolo mode \(unconfined\)/u);
	match(unconfined, /Yolo mode \(unconfined\)/u);
	doesNotMatch(unconfined, /Yolo is contained/u);
});

test("choosing unconfined yolo asks its own card and records the acceptance only on accept", async (t) => {
	const home = await isolateClioEnv("clio-yolo-unconfined-accept-");
	t.after(() => home.restore());
	const harness = (answer: string | null) => {
		let settings = structuredClone(readSettings());
		settings.safety.autonomy = "yolo";
		settings.safety.yoloAccepted = true;
		const commits: Array<[string, unknown, string]> = [];
		const activation = createYoloActivation({
			getSettings: () => settings,
			refusal: null,
			commitSetting: (id, next, scope) => {
				commits.push([
					id,
					id === "safety.yoloConfinement" ? next.safety.yoloConfinement : next.safety.yoloUnconfinedAccepted,
					scope,
				]);
				settings = structuredClone(next);
			},
			ask: async () =>
				answer === null
					? { answers: [], cancelled: true }
					: { answers: [{ question: "Unconfined yolo", answer, options: [answer] }] },
			prepareScreen: () => {},
			notify: () => {},
		});
		const choose = async () => {
			const next = structuredClone(settings);
			next.safety.yoloConfinement = "unconfined";
			activation.commit("safety.yoloConfinement", next, "global");
			for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
		};
		return { choose, commits };
	};
	const declined = harness(YOLO_UNCONFINED_DECLINE_LABEL);
	await declined.choose();
	deepStrictEqual(declined.commits, []);
	const cancelled = harness(null);
	await cancelled.choose();
	deepStrictEqual(cancelled.commits, []);
	const accepted = harness(YOLO_UNCONFINED_ACCEPT_LABEL);
	await accepted.choose();
	deepStrictEqual(accepted.commits, [
		["safety.yoloUnconfinedAccepted", true, "global"],
		["safety.yoloConfinement", "unconfined", "global"],
	]);
});

test("a project layer cannot set yolo confinement or its acceptance", async (t) => {
	const home = await isolateClioEnv("clio-yolo-confinement-project-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\nsafety:\n  autonomy: yolo\n");
	writeFileSync(
		join(workspace, ".clio-coder", "settings.local.yaml"),
		"safety:\n  yoloConfinement: unconfined\n  yoloUnconfinedAccepted: true\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	strictEqual(layered.settings.safety.yoloConfinement, "contained");
	strictEqual(layered.settings.safety.yoloUnconfinedAccepted, false);
	const paths = layered.issues.filter((issue) => issue.origin === "project.local").map((issue) => issue.path);
	deepStrictEqual(paths.sort(), ["safety.yoloConfinement", "safety.yoloUnconfinedAccepted"]);
});

test("the contained migration records the confinement once and keeps an operator's own choice", async (t) => {
	const home = await isolateClioEnv("clio-yolo-confinement-migration-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(settingsPath(), "version: 2\nsafety:\n  autonomy: yolo\n  yoloAccepted: true\n");
	strictEqual(recordYoloConfinementOnce(), true);
	match(readFileSync(settingsPath(), "utf8"), /yoloConfinement: contained/u);
	strictEqual(recordYoloConfinementOnce(), false);
	writeFileSync(settingsPath(), "version: 2\nsafety:\n  yoloConfinement: unconfined\n");
	strictEqual(recordYoloConfinementOnce(), false);
	match(readFileSync(settingsPath(), "utf8"), /yoloConfinement: unconfined/u);
});
