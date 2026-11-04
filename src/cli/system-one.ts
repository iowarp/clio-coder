import { dirname, resolve, sep } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { canonicalizePath } from "../core/path-canonical.js";
import { readLayeredSettings, settingsSourceFor } from "../core/settings-layers.js";
import { clioStateDir } from "../core/xdg.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import type { LlmRequestAdmission, OneShotPort } from "../domains/providers/one-shot.js";
import { exportToFile, isDay, summarizeDataset } from "../domains/system-one/recorder/index.js";
import type { DecisionRecord, SiteId } from "../domains/system-one/types.js";
import { SITE_IDS } from "../domains/system-one/types.js";
import { systemOneRecordingLabel } from "../domains/telemetry/consent.js";
import { telemetryRoot } from "../domains/telemetry/index.js";
import { formatColumns, printError, printNote } from "./shared.js";

const HELP = `clio-coder systemone status
clio-coder systemone use <engine> [--scope user|project]
clio-coder systemone off [--scope user|project]
clio-coder systemone check <engine> --live
clio-coder systemone calibrate <engine> [--sites <a,b>]
clio-coder systemone export --out <file> [--since <YYYY-MM-DD>] [--site <site>]

System One is experimental and off until you choose an engine: jev, memory, main,
a declared engine or a target. Its decision engines answer typed questions about the
operator's request, tool calls, tool results and finished turns; sites, keys and
cuts may change between releases. In research telemetry mode with
telemetry.research.systemOneDataset and content consent for the workspace, every
call and what followed it is kept in the session's telemetry journal as redacted
research content, which telemetry retention expires like any other.

status   what each site will do and why, whether recording is on, and what the dataset holds
use      choose the engine for every active site; the default scope is user, and a project
         write goes to .clio-coder/settings.local.yaml. /systemone sets task and session
         scope inside a session, and run --systemone sets one run
off      mask every site, per-site entries included
check    send one content-free decision to a hosted or self-hosted engine and report the
         build that answered, which is the only check that verifies a build
calibrate
         measure memory, main or a target's batch readout on the packaged labeled cases: it
         states the requests it will send, fits on fit, scores holdout once, stores a local
         measurement and prints what passed. Only what passed acts, only on that build
export   write one JSON line per decision to a local file, joined with the full text
         of its questions and every outcome recorded for it

Flags:
  --scope <scope>     user or project
  --live              required by check, because it sends a request
  --out <file>        destination of the export (required, replaced atomically)
  --since <day>       skip samples recorded before this UTC day
  --site <site>       only this site: ${SITE_IDS.join(", ")}
  --sites <a,b>       calibrate only these sites
`;

interface ParsedArgs {
	command?: string;
	name?: string;
	scope?: "user" | "project";
	live?: boolean;
	out?: string;
	since?: string;
	site?: SiteId;
	sites?: ReadonlyArray<string>;
	help: boolean;
}

function flagValue(argv: ReadonlyArray<string>, index: number, flag: string, what: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires ${what}`);
	return value;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (out.command === undefined && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		if (
			(out.command === "use" || out.command === "check" || out.command === "calibrate") &&
			out.name === undefined &&
			!arg.startsWith("-")
		) {
			out.name = arg;
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--live":
				out.live = true;
				break;
			case "--scope": {
				const scope = flagValue(argv, i, arg, "user or project");
				if (scope === "task" || scope === "session") {
					throw new Error(`${scope} scope belongs to a session: use /systemone there, or run --systemone for one run`);
				}
				if (scope !== "user" && scope !== "project") throw new Error(`--scope expects user or project, got ${scope}`);
				out.scope = scope;
				i += 1;
				break;
			}
			case "--sites":
				out.sites = flagValue(argv, i, arg, "site ids separated by commas").split(",");
				i += 1;
				break;
			case "--out":
				out.out = flagValue(argv, i, arg, "a file path");
				i += 1;
				break;
			case "--since": {
				const day = flagValue(argv, i, arg, "a day as YYYY-MM-DD");
				if (!isDay(day)) throw new Error(`--since expects a day as YYYY-MM-DD, got ${day}`);
				out.since = day;
				i += 1;
				break;
			}
			case "--site": {
				const site = flagValue(argv, i, arg, `one of ${SITE_IDS.join(", ")}`);
				if (!(SITE_IDS as ReadonlyArray<string>).includes(site)) {
					throw new Error(`--site expects one of ${SITE_IDS.join(", ")}, got ${site}`);
				}
				out.site = site as SiteId;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

async function runStatus(): Promise<number> {
	const layered = readLayeredSettings(process.cwd());
	const { settings } = layered;
	const { describeStatus, formatStatus } = await import("../domains/system-one/status.js");
	const { createMeasurementReader } = await import("../domains/system-one/measurement.js");
	const { credentialAvailable } = await import("../domains/providers/credentials.js");
	const recordingLabel = systemOneRecordingLabel(settings, process.cwd());
	const status = describeStatus({
		settings,
		settingsOrigin: settingsSourceFor(layered.sources, "systemOne.use"),
		hasCredential: credentialAvailable,
		recording: recordingLabel !== "record off",
		measurements: createMeasurementReader()(),
	});
	process.stdout.write(`${formatStatus(status).join("\n")}\n\n`);
	const summary = await summarizeDataset(clioStateDir());
	const rows: string[][] = [
		["record", recordingLabel.replace(/^record /, "")],
		[
			"samples",
			summary.decisions + summary.outcomes === 0
				? "none"
				: `decision ${summary.decisions}, outcome ${summary.outcomes} across ${summary.sessions} session${summary.sessions === 1 ? "" : "s"} (${summary.oldest} to ${summary.newest})`,
		],
	];
	process.stdout.write(formatColumns(rows));
	return 0;
}

async function runUse(use: string, scope: "user" | "project"): Promise<number> {
	const { writeSystemOneUse } = await import("../entry/system-one-settings.js");
	writeSystemOneUse(process.cwd(), scope, use);
	process.stdout.write(`System One ${use === "off" ? "off" : use} at ${scope} scope\n`);
	return runStatus();
}

/** The deps a process with no running session builds a System One from: settings in hand, no registered runtimes. */
async function offlineSystemOneDeps(live: Readonly<ClioSettings>) {
	const { BUILTIN_RUNTIMES } = await import("../domains/providers/runtimes/builtins.js");
	const { openAuthStorage, resolveAuthTarget } = await import("../domains/providers/auth/index.js");
	const { credentialAvailable } = await import("../domains/providers/credentials.js");
	const auth = openAuthStorage();
	const getTarget = (id: string) => live.targets.find((entry) => entry.id === id) ?? null;
	const getRuntime = (id: string) => BUILTIN_RUNTIMES.find((runtime) => runtime.id === id) ?? null;
	return {
		settings: () => live,
		providers: {
			getTarget,
			getRuntime,
			auth: {
				resolveForTarget: (
					target: Parameters<typeof resolveAuthTarget>[0],
					runtime: Parameters<typeof resolveAuthTarget>[1],
					options?: { signal?: AbortSignal },
				) => auth.resolveForTarget(resolveAuthTarget(target, runtime), options ?? {}),
			},
		} as never,
		// This process registers no runtime, so the set holds exactly the keys this runtime declares.
		credentialsPresent: () =>
			new Set(
				BUILTIN_RUNTIMES.flatMap((runtime) =>
					runtime.credentialsEnvVar !== undefined && credentialAvailable(runtime.id, runtime.credentialsEnvVar)
						? [runtime.credentialsEnvVar]
						: [],
				),
			),
	};
}

/** One content-free decision. A passive check proves an endpoint answers, never which build would answer. */
async function runCheck(name: string): Promise<number> {
	const settings = readLayeredSettings(process.cwd()).settings;
	const { effectiveSystemOne, resolveChoice } = await import("../domains/system-one/selection.js");
	const resolved = resolveChoice(settings, name);
	if (resolved.kind !== "engine") {
		printError(resolved.kind === "unavailable" ? resolved.problem : `'${name}' is not an engine`);
		return 1;
	}
	const live = effectiveSystemOne({ ...settings, systemOne: { ...settings.systemOne, sites: { consult: name } } }, name);
	const { createSystemOne, yesNo } = await import("../domains/system-one/index.js");
	const { consultSite } = await import("../domains/system-one/sites/consult.js");
	const { createMeasurementReader } = await import("../domains/system-one/measurement.js");
	const systemOne = createSystemOne({ ...(await offlineSystemOneDeps(live)), measurements: createMeasurementReader() });
	let failure = "the engine gave no answer";
	const verdict = await systemOne.run(
		consultSite({ check: yesNo("Is 2 greater than 1?", "It is greater", "It is not greater") }),
		{ state: { check: "build identity" }, files: {} },
		{ onFailure: (reason) => (failure = reason) },
	);
	const requested = resolved.engine.model ?? "target default";
	if (verdict === null) {
		printError(`${name} (${requested}): ${failure}; nothing is verified`);
		return 1;
	}
	const { FITTED_CUTS } = await import("../domains/system-one/calibration.js");
	const { IDENTITY_LIMIT } = await import("../domains/system-one/status.js");
	const index = createMeasurementReader()();
	const measured = Object.hasOwn(FITTED_CUTS, verdict.build) || Object.hasOwn(index.cuts, verdict.build);
	// An LLM route's build is what its server reported, so a measurement of it is the only name to match.
	const matches = resolved.engine.kind === "llm" ? measured : verdict.build === requested;
	process.stdout.write(
		`${name}: requested ${requested}, answered as ${verdict.build} in ${verdict.latencyMs} ms\n` +
			`${matches ? "the answering name matches" : "the answering name differs, so no measurement for the requested build applies"}; ` +
			`${measured ? "this build has measured cuts" : "this build has no measured cuts, so it sends nothing"}\n${IDENTITY_LIMIT}\n`,
	);
	return matches ? 0 : 1;
}

function formatTally(tally: { hits: number; positives: number; falseFires: number; negatives: number }): string {
	return `${tally.hits}/${tally.positives} right, ${tally.falseFires}/${tally.negatives} false`;
}

/** A runtime with no chat wire answers through the port the orchestrator uses, and this process boots no orchestrator. */
async function domainOneShot(admit: LlmRequestAdmission, cleanups: Array<() => Promise<void>>): Promise<OneShotPort> {
	const { loadDomains } = await import("../core/domain-loader.js");
	const { ConfigDomainModule } = await import("../domains/config/index.js");
	const { ProvidersDomainModule } = await import("../domains/providers/index.js");
	const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
	cleanups.push(() => loaded.stop());
	const providers = loaded.getContract<ProvidersContract>("providers");
	if (!providers) throw new Error("provider domain not loaded");
	const { createSystemOneOneShot } = await import("../entry/orchestrator.js");
	return createSystemOneOneShot(providers, admit);
}

/** Measure a batch route on the packaged cases and store what passed. */
async function runCalibrate(
	name: string,
	only: ReadonlyArray<string> | undefined,
	cleanups: Array<() => Promise<void>>,
): Promise<number> {
	const settings = readLayeredSettings(process.cwd()).settings;
	const { effectiveSystemOne, resolveChoice } = await import("../domains/system-one/selection.js");
	const resolved = resolveChoice(settings, name);
	if (resolved.kind !== "engine") {
		printError(resolved.kind === "unavailable" ? resolved.problem : `'${name}' is not an engine`);
		return 1;
	}
	if (resolved.engine.kind !== "llm" || resolved.engine.mode !== "batch") {
		printError(
			resolved.engine.kind === "llm"
				? `${name} does not read in batch mode; set mode: batch on the engine to calibrate it`
				: `${name} answers with probabilities, whose cuts are fitted with scripts/decision-probe.ts from a source checkout`,
		);
		return 1;
	}
	const { addCalibrationSpend, CALIBRATION_SITES, CalibrationStopped, calibrateSite, planRequests } = await import(
		"../domains/system-one/calibrate.js"
	);
	const sites = CALIBRATION_SITES.filter((entry) => only === undefined || only.includes(entry.id));
	const unknown = (only ?? []).filter((id) => !CALIBRATION_SITES.some((entry) => entry.id === id));
	if (unknown.length > 0 || sites.length === 0) {
		printError(`--sites takes ${CALIBRATION_SITES.map((entry) => entry.id).join(", ")}`);
		return 2;
	}
	const { batchRequestKey } = await import("../domains/system-one/engines/llm.js");
	const { resolveEffectivePricing } = await import("../domains/providers/catalog.js");
	const { renderUsdSpend } = await import("../core/telemetry/render.js");
	const { createSideRequestAdmission } = await import("../entry/side-request-admission.js");
	const { indexMeasurements, LABEL_POLICY_VERSION, readMeasurement, writeMeasurement } = await import(
		"../domains/system-one/measurement.js"
	);
	const { createSystemOne, yesNo } = await import("../domains/system-one/index.js");
	const { consultSite } = await import("../domains/system-one/sites/consult.js");
	const { IDENTITY_LIMIT } = await import("../domains/system-one/status.js");
	const engineCfg = resolved.engine;
	const target = settings.targets.find((entry) => entry.id === engineCfg.target);
	if (target === undefined) {
		printError(`target '${engineCfg.target}' is not configured`);
		return 1;
	}
	const requestKey = batchRequestKey(target, target.runtime, engineCfg.model ?? null);
	if (requestKey === null) {
		printError(`target '${target.id}' names no model to ask`);
		return 1;
	}
	const plan = planRequests(sites);
	process.stdout.write(
		`${name}: ${target.id}/${engineCfg.model ?? target.defaultModel}
` +
			`will send up to ${plan.total + 1} requests, one per labeled case and one to learn the answering identity: ` +
			`${Object.entries(plan.perSite)
				.map(([site, count]) => `${site} ${count}`)
				.join(", ")}.
A site's holdout is skipped when no key passes its fit.
`,
	);
	// Generous while measuring, because the point is to learn how long a call takes on this route.
	const binding = { engine: name, timeoutMs: 120_000 };
	const live = effectiveSystemOne(
		{
			...settings,
			systemOne: {
				...settings.systemOne,
				sites: { turn: binding, workerPrepare: binding, toolCall: binding, consult: binding },
			},
		},
		name,
	);
	const deps = await offlineSystemOneDeps(live);
	const runtime = deps.providers as unknown as {
		getRuntime(id: string): { id: string } | null;
	};
	const spend = { usd: 0, unpriced: false };
	const admit = createSideRequestAdmission({
		providers: deps.providers as never,
		telemetry: { settledSessionSpend: async () => ({ usd: spend.usd }) } as never,
		getCeilingUsd: () => settings.safety.limits.sessionCostUsd,
		currentSession: () => null,
		repoIdentity: () => null,
	});
	let last: DecisionRecord | null = null;
	const placeholders: Record<string, Record<string, number>> = {};
	let learned: string | null = null;
	const admitLlmRequest: LlmRequestAdmission = async (request) => {
		const account = await admit(request);
		const pricing = resolveEffectivePricing(
			target,
			runtime.getRuntime(target.runtime) ?? { id: target.runtime },
			request.model,
		);
		return Object.assign(
			(usage: Parameters<typeof account>[0], observation?: Parameters<typeof account>[1]) => {
				account(usage, observation);
				if (usage !== null) addCalibrationSpend(spend, pricing, usage);
			},
			account.withContext ? { withContext: account.withContext } : {},
		);
	};
	const { hasChatWire } = await import("../domains/system-one/engines/llm-wire.js");
	const system = createSystemOne({
		...deps,
		...(hasChatWire(target.runtime) ? {} : { oneShot: await domainOneShot(admitLlmRequest, cleanups) }),
		// A site that requires a cut sends nothing without one, so the build under measurement holds a placeholder.
		localCuts: () => placeholders,
		measurements: () => ({
			...indexMeasurements([]),
			buildsFor: () => (learned === null ? [] : [learned]),
		}),
		admitLlmRequest,
		recorder: () => ({
			decision: (row) => {
				last = row;
			},
			outcome: () => undefined,
		}),
	});
	let failure = "the engine gave no answer";
	await system.run(
		consultSite({ check: yesNo("Is 2 greater than 1?", "It is greater", "It is not greater") }),
		{ state: { check: "build identity" }, files: {} },
		{ onFailure: (reason) => (failure = reason) },
	);
	// The build comes from the response, so an abstention on this question still names it.
	const build = (last as DecisionRecord | null)?.build ?? null;
	if (build === null) {
		printError(`${name}: ${failure}; nothing is measured`);
		return 1;
	}
	learned = build;
	placeholders[build] = { "toolCall.cardFloor": 1, "workerPrepare.recipe": 1 };
	process.stdout.write(`answering identity: ${build}\n`);
	const started = performance.now();
	const prior = readMeasurement(requestKey);
	// A partial run keeps the sites it did not touch, while they describe the same build.
	const kept = prior !== null && prior.build === build && prior.policy === LABEL_POLICY_VERSION ? prior : null;
	const measuredSites = { ...kept?.sites };
	const keys = { ...kept?.keys };
	const raw: unknown[] = [];
	try {
		for (const entry of sites) {
			const run = await calibrateSite({
				entry,
				build,
				system,
				takeRecord: () => {
					const row = last;
					last = null;
					return row;
				},
				onProgress: (done, total) => {
					if (done % 25 === 0 || done === total) process.stderr.write(`${entry.id}: ${done}/${total}\n`);
				},
			});
			measuredSites[entry.id] = run.site;
			for (const key of Object.keys(keys)) if (key.startsWith(`${entry.id}.`)) delete keys[key];
			Object.assign(keys, run.keys);
			raw.push(...run.raw);
		}
	} catch (error) {
		if (!(error instanceof CalibrationStopped)) throw error;
		printError(`${error.message}; no measurement was stored`);
		return 1;
	}
	const path = writeMeasurement(
		{
			v: 1,
			requestKey,
			build,
			measuredAt: new Date().toISOString(),
			policy: LABEL_POLICY_VERSION,
			sites: measuredSites,
			keys,
		},
		raw,
	);
	for (const entry of sites) {
		const run = measuredSites[entry.id];
		if (run === undefined) continue;
		process.stdout.write(
			`\n${entry.id} ${run.version}: ${run.requests} requests, ${run.failed} failed, ${run.tokens.input} tokens in, ${run.tokens.output} out, ` +
				`p50 ${run.latencyMs.p50} ms, p95 ${run.latencyMs.p95} ms, max ${run.latencyMs.max} ms, deadline ${run.deadlineMs} ms\n`,
		);
		for (const [key, result] of Object.entries(keys)) {
			if (!key.startsWith(`${entry.id}.`)) continue;
			process.stdout.write(
				`  ${result.pass ? "pass" : "fail"} ${key} k${result.k}: fit ${formatTally(result.fit)}` +
					`${result.holdout === undefined ? "" : `; holdout ${formatTally(result.holdout)}`}` +
					`${result.reason === undefined ? "" : `; ${result.reason}`}\n`,
			);
		}
	}
	const seconds = Math.round((performance.now() - started) / 1000);
	const money = renderUsdSpend(spend.usd, { estimated: true, unpriced: spend.unpriced });
	process.stdout.write(`\n${seconds} s, ${money}\nstored ${path}\n${IDENTITY_LIMIT}\n`);
	return 0;
}

async function runExport(parsed: ParsedArgs): Promise<number> {
	if (parsed.out === undefined) {
		printError("export requires --out <file>");
		process.stderr.write(HELP);
		return 2;
	}
	const destination = resolve(parsed.out);
	const parent = canonicalizePath(dirname(destination));
	const telemetry = canonicalizePath(telemetryRoot(clioStateDir())) ?? telemetryRoot(clioStateDir());
	if (parent === null) {
		printError("--out could not be checked against the telemetry directory");
		return 2;
	}
	if (parent === telemetry || parent.startsWith(`${telemetry}${sep}`)) {
		printError("--out must not point into the telemetry directory");
		return 2;
	}
	// The file holds redacted state, but redaction is best effort and the operator's own requests are in it.
	// Rows are streamed to the temp file, so a large dataset is never one string.
	const result = await exportToFile(destination, {
		stateDir: clioStateDir(),
		...(parsed.since !== undefined ? { since: parsed.since } : {}),
		...(parsed.site !== undefined ? { site: parsed.site } : {}),
	});
	process.stdout.write(
		`exported ${result.decisions} decision${result.decisions === 1 ? "" : "s"} from ${result.sessions} session${result.sessions === 1 ? "" : "s"} to ${destination}\n`,
	);
	if (result.decisions === 0) printNote("no decisions matched; the file is empty.");
	if (result.missingSpecs > 0) {
		printNote(`${result.missingSpecs} question spec${result.missingSpecs === 1 ? "" : "s"} missing from their samples.`);
	}
	if (result.unreadableRows > 0)
		printNote(`${result.unreadableRows} unreadable sample${result.unreadableRows === 1 ? "" : "s"} skipped.`);
	return 0;
}

export async function runSystemOneCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const known = ["status", "export", "use", "off", "check", "calibrate"];
	if (parsed.command === undefined || !known.includes(parsed.command)) {
		if (parsed.command !== undefined) printError(`unknown systemone command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}
	if (
		(parsed.command === "use" || parsed.command === "check" || parsed.command === "calibrate") &&
		parsed.name === undefined
	) {
		printError(`${parsed.command} requires an engine`);
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.command === "check" && parsed.live !== true) {
		printError("check sends a request, so it requires --live");
		return 2;
	}
	const cleanups: Array<() => Promise<void>> = [];
	try {
		if (parsed.command === "use") return await runUse(parsed.name as string, parsed.scope ?? "user");
		if (parsed.command === "off") return await runUse("off", parsed.scope ?? "user");
		if (parsed.command === "check") return await runCheck(parsed.name as string);
		if (parsed.command === "calibrate") return await runCalibrate(parsed.name as string, parsed.sites, cleanups);
		return parsed.command === "status" ? await runStatus() : await runExport(parsed);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		await Promise.all(cleanups.map((cleanup) => cleanup()));
	}
}
