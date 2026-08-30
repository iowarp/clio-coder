/**
 * A model the target does not serve is refused at configure time, reported by
 * doctor, and shown as degraded by `targets --probe`.
 *
 * The README's own quickstart, copy-pasted with the `your-model-id`
 * placeholder, used to print `probe ok ... 38 models` and `ok: target saved`,
 * write the 38 real ids into `wireModels` beside the placeholder, pass doctor
 * with no model row, print `healthy` under `targets --probe`, and fail on the
 * first turn. The static-catalog check let every string through because the
 * lmstudio catalog is empty, and the live list the same command fetched was
 * never compared against the model it was saving.
 */

import { match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runConfigureCommand } from "../../src/cli/configure.js";
import { targetTableRow } from "../../src/cli/targets.js";
import { formatUnadvertisedModelReason, validateModelChoice } from "../../src/cli/validate-model.js";
import { readSettings, settingsPath } from "../../src/core/config.js";
import { runDoctorModelChecks } from "../../src/domains/lifecycle/doctor.js";
import { unservedDefaultModelReason } from "../../src/domains/providers/extension.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { type FakeLmStudioFixture, startFakeLmStudioServer } from "../harness/fake-lmstudio-server.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

/** The fake LM Studio advertises these: two loaded instances of one key, one unloaded key, one embedding key. */
const ADVERTISED = {
	loadedInstance: "qwen3.8-27b-zbook",
	loadedKey: "qwen3.8-27b",
	unloadedKey: "coder-unloaded",
} as const;
const PLACEHOLDER = "your-model-id";

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: await run(), stderr };
	} finally {
		process.stderr.write = original;
	}
}

function configureArgs(url: string, model: string, ...extra: string[]): string[] {
	return ["--id", "studio", "--runtime", "lmstudio", "--url", url, "--model", model, "--set-orchestrator", ...extra];
}

function settingsYaml(url: string, model: string, wireModels: ReadonlyArray<string>): string {
	const list = wireModels.length > 0 ? `\n    wireModels:\n${wireModels.map((id) => `      - ${id}`).join("\n")}` : "";
	return `targets:
  - id: studio
    runtime: lmstudio
    url: ${url}
    defaultModel: ${model}${list}
orchestrator:
  target: studio
  model: ${model}
`;
}

describe("contracts/model residency: configure", () => {
	let scratch: IsolatedClioEnv;
	let server: FakeLmStudioFixture;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-model-residency-configure-");
		server = await startFakeLmStudioServer();
	});

	afterEach(async () => {
		// A case may have closed the server itself; the env lock must be released
		// either way or the next case's beforeEach waits on it forever.
		try {
			await server.close();
		} catch {
			// already closed by the case
		}
		scratch.restore();
	});

	it("refuses a model the target does not advertise and names the resident instances", async () => {
		const { result: code, stderr } = await captureStderr(() =>
			runConfigureCommand(configureArgs(server.url, PLACEHOLDER)),
		);
		strictEqual(code, 2, `stderr=${stderr}`);
		strictEqual(readSettings().targets.length, 0, "nothing was saved");
		strictEqual(readSettings().orchestrator.target, null, "the orchestrator pointer was not moved");
		const line = stderr.split("\n").find((entry) => entry.startsWith("error: "));
		ok(line, `no refusal on stderr:\n${stderr}`);
		ok(line.includes(`target 'studio' at ${server.url} does not advertise model '${PLACEHOLDER}'`), line);
		ok(line.includes("Advertised (5): "), line);
		for (const id of Object.values(ADVERTISED)) ok(line.includes(id), `${id} missing from ${line}`);
		match(line, /Resident instances: [^\n]*?qwen3\.8-27b-zbook/u, line);
		ok(
			line.endsWith("Pass one of the advertised ids with --model, or --force to save a model the target cannot serve."),
			line,
		);
	});

	it("accepts an advertised model whether it is loaded, listed by key, or not yet loaded", async () => {
		for (const model of [ADVERTISED.loadedInstance, ADVERTISED.loadedKey, ADVERTISED.unloadedKey]) {
			const { result: code, stderr } = await captureStderr(() => runConfigureCommand(configureArgs(server.url, model)));
			strictEqual(code, 0, `${model}: stderr=${stderr}`);
			ok(!stderr.includes("does not advertise"), `${model} was wrongly refused:\n${stderr}`);
			strictEqual(readSettings().targets[0]?.defaultModel, model);
		}
	});

	it("saves an unadvertised model under --force with a warning instead of a refusal", async () => {
		const { result: code, stderr } = await captureStderr(() =>
			runConfigureCommand(configureArgs(server.url, PLACEHOLDER, "--force")),
		);
		strictEqual(code, 0, `stderr=${stderr}`);
		strictEqual(readSettings().targets[0]?.defaultModel, PLACEHOLDER);
		match(stderr, /^warning: .*does not advertise model 'your-model-id'.*Saved anyway because of --force\.$/mu, stderr);
		ok(!stderr.includes("error:"), stderr);
	});

	it("scopes the empty-catalog pass so a present live list is checked and an absent one is not", () => {
		const live = { targetId: "studio", url: "http://127.0.0.1:1", models: ["a", "b"], resident: ["a"] };
		const refused = validateModelChoice({ runtimeId: "lmstudio", modelId: "c", knownModels: [], live, force: false });
		strictEqual(refused.ok, false);
		ok(!refused.ok && refused.reason === formatUnadvertisedModelReason("c", live));
		strictEqual(
			validateModelChoice({ runtimeId: "lmstudio", modelId: "b", knownModels: [], live, force: false }).ok,
			true,
		);
		// No catalog and no live list: nothing to check against, so the id passes as before.
		strictEqual(validateModelChoice({ runtimeId: "lmstudio", modelId: "c", knownModels: [], force: false }).ok, true);
		// A catalog stays the authority even when a live list is also present.
		const catalog = validateModelChoice({
			runtimeId: "openai",
			modelId: "c",
			knownModels: ["c"],
			live: { ...live, models: ["a"] },
			force: false,
		});
		strictEqual(catalog.ok, true);
	});
});

describe("contracts/model residency: doctor", () => {
	let scratch: IsolatedClioEnv;
	let server: FakeLmStudioFixture;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-model-residency-doctor-");
		server = await startFakeLmStudioServer();
	});

	afterEach(async () => {
		// A case may have closed the server itself; the env lock must be released
		// either way or the next case's beforeEach waits on it forever.
		try {
			await server.close();
		} catch {
			// already closed by the case
		}
		scratch.restore();
	});

	it("reports a defaultModel and orchestrator.model the live target does not advertise", async () => {
		writeFileSync(settingsPath(), settingsYaml(server.url, PLACEHOLDER, [ADVERTISED.loadedInstance]), "utf8");
		const findings = await runDoctorModelChecks();
		strictEqual(findings.length, 1, JSON.stringify(findings));
		const finding = findings[0];
		ok(finding);
		strictEqual(finding.name, "model studio");
		strictEqual(finding.ok, false);
		ok(
			finding.detail.includes(
				`defaultModel '${PLACEHOLDER}', orchestrator.model '${PLACEHOLDER}' not advertised by ${server.url} now`,
			),
			finding.detail,
		);
		match(finding.detail, /Resident instances: [^\n]*?qwen3\.8-27b-zbook/u, finding.detail);
		ok(finding.detail.includes("clio-coder configure --id studio --model <advertised id>"), finding.detail);
	});

	it("passes an advertised model and says which list it was checked against", async () => {
		writeFileSync(settingsPath(), settingsYaml(server.url, ADVERTISED.unloadedKey, []), "utf8");
		const [finding] = await runDoctorModelChecks();
		ok(finding);
		strictEqual(finding.ok, true);
		strictEqual(finding.level, undefined);
		ok(finding.detail.includes(`advertised by ${server.url} now`), finding.detail);
	});

	it("falls back to the wireModels configure recorded when the target is down", async () => {
		writeFileSync(settingsPath(), settingsYaml(server.url, PLACEHOLDER, [ADVERTISED.loadedInstance]), "utf8");
		await server.close();
		const [finding] = await runDoctorModelChecks();
		ok(finding);
		strictEqual(finding.ok, false);
		ok(finding.detail.includes("not recorded by configure at last save (1 ids)"), finding.detail);
		ok(finding.detail.includes("Resident instances: unknown"), finding.detail);
	});

	it("warns rather than passes when there is no list at all to check against", async () => {
		writeFileSync(settingsPath(), settingsYaml(server.url, PLACEHOLDER, []), "utf8");
		await server.close();
		const [finding] = await runDoctorModelChecks();
		ok(finding);
		strictEqual(finding.ok, true);
		strictEqual(finding.level, "warn");
		ok(finding.detail.includes("could not be verified"), finding.detail);
	});
});

describe("contracts/model residency: targets --probe", () => {
	function status(overrides: Partial<TargetStatus>): TargetStatus {
		return {
			target: { id: "studio", runtime: "lmstudio", url: "http://127.0.0.1:1", defaultModel: PLACEHOLDER },
			runtime: null,
			available: true,
			reason: "",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 12 },
			capabilities: EMPTY_CAPABILITIES,
			discoveredModels: [ADVERTISED.loadedInstance],
			discoveredModelsSource: "probe",
			discoveredModelStates: { [ADVERTISED.loadedInstance]: { state: "loaded" } },
			...overrides,
		};
	}
	const providers = {
		auth: { statusForTarget: () => ({ available: true, source: "none" }) },
	} as unknown as ProvidersContract;

	it("judges the default only from a live list on a runtime with no catalog", () => {
		const merge = {
			discoveredModels: [ADVERTISED.loadedInstance],
			discoveredModelsSource: "probe" as const,
			discoveredModelStates: {
				[ADVERTISED.loadedInstance]: { state: "loaded" as const },
				[ADVERTISED.loadedKey]: { state: "loaded" as const },
			},
		};
		const desc = { id: "lmstudio" };
		strictEqual(
			unservedDefaultModelReason(desc, { defaultModel: PLACEHOLDER }, merge),
			`default model '${PLACEHOLDER}' is not advertised by the target`,
		);
		strictEqual(unservedDefaultModelReason(desc, { defaultModel: ADVERTISED.loadedInstance }, merge), null);
		strictEqual(
			unservedDefaultModelReason(desc, { defaultModel: ADVERTISED.loadedKey }, merge),
			null,
			"a key in the state map counts",
		);
		strictEqual(unservedDefaultModelReason(desc, {}, merge), null, "no default, nothing to judge");
		strictEqual(
			unservedDefaultModelReason(desc, { defaultModel: PLACEHOLDER }, { ...merge, discoveredModelsSource: "cache" }),
			null,
			"a cached list is not evidence about the server now",
		);
		strictEqual(
			unservedDefaultModelReason({ id: "openai" }, { defaultModel: PLACEHOLDER }, merge),
			null,
			"a catalog runtime is judged by its catalog at configure time",
		);
	});

	it("prints degraded with the reason beside the model, not plain healthy", () => {
		const reason = `default model '${PLACEHOLDER}' is not advertised by the target`;
		const degraded = targetTableRow(
			providers,
			status({
				target: {
					id: "studio",
					runtime: "lmstudio",
					url: "http://127.0.0.1:1",
					defaultModel: PLACEHOLDER,
					gateway: true,
				},
				capabilities: { ...EMPTY_CAPABILITIES, contextWindow: 262_144 },
				health: { status: "degraded", lastCheckAt: null, lastError: reason, latencyMs: 12 },
			}),
		);
		strictEqual(degraded.model, PLACEHOLDER);
		strictEqual(degraded.health, "degraded");
		strictEqual(degraded.diagnostic, reason);
		strictEqual(degraded.notes.indexOf(reason), 0, degraded.notes);
		ok(degraded.notes.indexOf("gateway") > degraded.notes.indexOf(reason), degraded.notes);
		ok(degraded.notes.indexOf("ctx 262144") > degraded.notes.indexOf(reason), degraded.notes);
		ok(degraded.notes.includes(`resident: ${ADVERTISED.loadedInstance}`), degraded.notes);
		ok(degraded.notes.indexOf("resident:") > degraded.notes.indexOf(reason), degraded.notes);

		const healthy = targetTableRow(providers, status({}));
		strictEqual(healthy.health, "healthy");
		strictEqual(healthy.notes, `resident: ${ADVERTISED.loadedInstance}`);
		strictEqual(healthy.diagnostic, undefined);
	});
});

describe("contracts/model residency: the built CLI end to end", () => {
	let server: FakeLmStudioFixture;
	const scratch = makeScratchHome("clio-model-residency-cli-");

	beforeEach(async () => {
		server = await startFakeLmStudioServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it("refuses the README placeholder, then doctor and targets --probe report a forced one", async () => {
		const refused = await runCli(["configure", ...configureArgs(server.url, PLACEHOLDER)], {
			env: scratch.env,
			input: "",
		});
		strictEqual(refused.code, 2, `stdout=${refused.stdout}\nstderr=${refused.stderr}`);
		ok(refused.stderr.includes(`does not advertise model '${PLACEHOLDER}'`), refused.stderr);
		ok(!refused.stdout.includes("saved"), refused.stdout);

		const forced = await runCli(["configure", ...configureArgs(server.url, PLACEHOLDER, "--force")], {
			env: scratch.env,
			input: "",
		});
		strictEqual(forced.code, 0, `stdout=${forced.stdout}\nstderr=${forced.stderr}`);

		// The interop sweep spawns every detected agent binary for its version and
		// is bounded per binary, so doctor needs more than the default 15s here.
		const doctor = await runCli(["doctor"], { env: scratch.env, input: "", timeoutMs: 60_000 });
		strictEqual(doctor.code, 1, `stdout=${doctor.stdout}\nstderr=${doctor.stderr}`);
		const modelRow = doctor.stdout.split("\n").find((line) => line.includes("model studio"));
		ok(modelRow, doctor.stdout);
		ok(modelRow.startsWith("!!"), modelRow);
		ok(modelRow.includes(`defaultModel '${PLACEHOLDER}', orchestrator.model '${PLACEHOLDER}' not advertised`), modelRow);

		const probe = await runCli(["targets", "--probe", "--json"], { env: scratch.env, input: "" });
		strictEqual(probe.code, 0, `stdout=${probe.stdout}\nstderr=${probe.stderr}`);
		const parsed = JSON.parse(probe.stdout) as {
			targets: Array<{ target: { id: string }; health: { status: string; lastError: string | null } }>;
		};
		const studio = parsed.targets.find((entry) => entry.target.id === "studio");
		ok(studio, probe.stdout);
		strictEqual(studio.health.status, "degraded");
		strictEqual(studio.health.lastError, `default model '${PLACEHOLDER}' is not advertised by the target`);

		const table = await runCli(["targets", "--probe"], { env: scratch.env, input: "" });
		const row = table.stdout.split("\n").find((line) => line.startsWith("studio"));
		ok(row, table.stdout);
		ok(row.includes("degraded"), row);
		ok(!/\bhealthy\b/u.test(row), row);
	});
});
