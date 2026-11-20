import type { HealthV1, QuotaStateV1, RunRowV1 } from "../core/telemetry/dto.js";
import { clioStateDir } from "../core/xdg.js";
import {
	loadHostQuotaRecordsAsync,
	loadProcessTelemetrySourceAsync,
	loadRunScopeFiles,
	loadRunScopeFilesAsync,
	loadRunTelemetrySourceAsync,
	loadSessionTelemetrySourceAsync,
} from "../domains/session/telemetry-source.js";
import type { LiveTelemetryModel } from "../domains/telemetry/telemetry-live.js";
import { createLiveTelemetryModel } from "../domains/telemetry/telemetry-live.js";
import { formatColumns } from "./argv.js";
import { parseCommandFlags } from "./kit/flags.js";
import { writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";
import { resolveSessionSelector } from "./telemetry-target.js";

/**
 * `clio-coder telemetry quota|health|runs` (#434 §11.3): the CLI routes for ACP's `_clio-coder/telemetry/quota`,
 * `health` and `runs` request/reply methods. Each builds the telemetry domain's read model over this state directory
 * and prints the DTO the method returns: `--json` emits it verbatim, the text form prints its display strings.
 * Nothing here polls a provider or computes a total; quota reads the readings this host journaled.
 */

/** The longest provider id ACP's quota method accepts. */
const MAX_PROVIDER_LENGTH = 512;

function fail(verb: string, json: boolean, slug: ErrorSlug, message: string, code: number): number {
	writeCliFailure({ path: ["telemetry", verb], slug, message, json });
	return code;
}

function emit<T>(dto: T, json: boolean, text: (dto: T) => string): number {
	process.stdout.write(json ? `${JSON.stringify(dto, null, 2)}\n` : text(dto));
	return 0;
}

/**
 * The read model ACP serves, built as the telemetry extension builds it, with the session domain's cold loader. The
 * host's journaled quota readings seed on the first quota read without a promise to await; `hostQuota` settles when
 * that read does, so a one-shot command can print what a long-lived server shows once its seed has landed.
 */
function snapshotModel(stateDir: string): { model: LiveTelemetryModel; hostQuota: Promise<void> } {
	let settled: () => void = () => {};
	const hostQuota = new Promise<void>((resolve) => {
		settled = resolve;
	});
	const model = createLiveTelemetryModel({
		stateDir: () => stateDir,
		loader: async () => ({
			loadSessionTelemetrySourceAsync,
			loadRunTelemetrySourceAsync,
			loadProcessTelemetrySourceAsync,
			loadRunScopeFiles,
			loadRunScopeFilesAsync,
			loadHostQuotaRecordsAsync: (directory: string) => {
				let read: ReturnType<typeof loadHostQuotaRecordsAsync>;
				try {
					read = loadHostQuotaRecordsAsync(directory);
				} catch (error) {
					read = Promise.reject(error);
				}
				void read.then(settled, settled);
				return read;
			},
		}),
	});
	return { model, hostQuota };
}

async function readQuota(stateDir: string, provider: string | undefined): Promise<QuotaStateV1> {
	const { model, hostQuota } = snapshotModel(stateDir);
	try {
		// The first read asks for the host's journaled readings; the model folds them in once every microtask the
		// read resolved has run, which a macrotask turn guarantees.
		model.quota(provider);
		await hostQuota;
		await new Promise<void>((resolve) => setImmediate(resolve));
		return model.quota(provider);
	} finally {
		model.stop();
	}
}

function readHealth(stateDir: string): HealthV1 {
	const { model } = snapshotModel(stateDir);
	try {
		return model.health();
	} finally {
		model.stop();
	}
}

async function readRuns(stateDir: string, sessionId: string): Promise<RunRowV1[] | null> {
	const { model } = snapshotModel(stateDir);
	try {
		return (await model.open(sessionId))?.runs() ?? null;
	} finally {
		model.stop();
	}
}

function printQuota(dto: QuotaStateV1): string {
	if (dto.providers.length === 0) return "no quota readings on this host\n";
	const lines: string[] = [];
	for (const row of dto.providers) {
		lines.push(
			`${row.displayName} (${row.provider}) ${row.status}${row.plan ? ` · ${row.plan}` : ""} · ${row.source}${
				row.observedAt ? ` at ${row.observedAt}` : ""
			}${row.stale ? " · stale" : ""}`,
		);
		if (row.credits) lines.push(`  credits ${row.credits.display} · ${row.credits.usedPct.display} used`);
		for (const window of row.windows)
			lines.push(
				`  ${window.label ?? window.key}  ${window.usedPct.display} used${
					window.consumedPct ? ` (+${window.consumedPct.display} between the last two readings)` : ""
				}${window.resetsAt ? ` · resets ${window.resetsAt}` : ""}`,
			);
		if (row.retryAfter) lines.push(`  retry after ${row.retryAfter.display}`);
		if (row.message) lines.push(`  ${row.message}`);
	}
	return `${lines.join("\n")}\n`;
}

function printHealth(dto: HealthV1): string {
	const lines = [
		`producer  unowned records ${dto.producer.unownedRecords.display} · sink failures ${dto.producer.sinkFailures.display}`,
		`loop lag  p50 ${dto.loopLag.p50.display} · p99 ${dto.loopLag.p99.display} · max ${dto.loopLag.max.display}`,
		`journals  ${dto.journals.length === 0 ? "none open in this process" : `${dto.journals.length} open`}`,
	];
	if (dto.journals.length > 0)
		lines.push(
			formatColumns([
				["owner", "queue", "persisted", "dropped", "invalid", "filtered", "write errors"],
				...dto.journals.map((journal) => [
					journal.owner,
					journal.queueDepth.display,
					journal.persisted.display,
					journal.dropped.display,
					journal.invalid.display,
					journal.filtered.display,
					journal.writeErrors.display,
				]),
			]).trimEnd(),
		);
	return `${lines.join("\n")}\n`;
}

function printRuns(rows: RunRowV1[]): string {
	if (rows.length === 0) return "no runs\n";
	return formatColumns([
		["run", "turn", "first", "last", "settled", "source", "calls", "tokens", "cost"],
		...rows.map((row) => [
			row.runId,
			row.turnId ?? "",
			row.firstAt ?? "",
			row.lastAt ?? "",
			row.terminalReason ?? "not settled",
			row.source,
			row.apiCalls.display,
			row.tokens.display,
			row.usd.display,
		]),
	]);
}

async function runQuota(argv: ReadonlyArray<string>): Promise<number> {
	const parsed = parseCommandFlags(argv, { provider: { kind: "value" }, json: { kind: "boolean" } });
	if (!parsed.ok) return fail("quota", argv.includes("--json"), parsed.slug, parsed.message, 2);
	const json = parsed.flags.json === true;
	if (parsed.positional.length > 0)
		return fail("quota", json, "usage", `unexpected argument: ${parsed.positional[0]}`, 2);
	const provider = parsed.flags.provider;
	if (provider !== undefined && (provider.length === 0 || provider.length > MAX_PROVIDER_LENGTH))
		return fail("quota", json, "usage", "--provider takes a provider id", 2);
	try {
		return emit(await readQuota(clioStateDir(), provider), json, printQuota);
	} catch (error) {
		return fail("quota", json, "io", `cannot read telemetry: ${errorText(error)}`, 1);
	}
}

function runHealth(argv: ReadonlyArray<string>): number {
	const parsed = parseCommandFlags(argv, { json: { kind: "boolean" } });
	if (!parsed.ok) return fail("health", argv.includes("--json"), parsed.slug, parsed.message, 2);
	const json = parsed.flags.json === true;
	if (parsed.positional.length > 0)
		return fail("health", json, "usage", `unexpected argument: ${parsed.positional[0]}`, 2);
	try {
		return emit(readHealth(clioStateDir()), json, printHealth);
	} catch (error) {
		return fail("health", json, "io", `cannot read telemetry: ${errorText(error)}`, 1);
	}
}

async function runRuns(argv: ReadonlyArray<string>): Promise<number> {
	const parsed = parseCommandFlags(argv, { session: { kind: "value" }, json: { kind: "boolean" } });
	if (!parsed.ok) return fail("runs", argv.includes("--json"), parsed.slug, parsed.message, 2);
	const json = parsed.flags.json === true;
	const sessionFlag = parsed.flags.session;
	if (parsed.positional.length > (sessionFlag === undefined ? 1 : 0))
		return fail(
			"runs",
			json,
			"usage",
			sessionFlag === undefined
				? `unexpected argument: ${parsed.positional[1]}`
				: "give the session once: as an argument or as --session",
			2,
		);
	const selector = sessionFlag ?? parsed.positional[0];
	if (selector === undefined || selector.length === 0) return fail("runs", json, "usage", "runs needs a session", 2);
	try {
		const stateDir = clioStateDir();
		// A session selector is an id, a unique prefix or a name (C13).
		const selected = resolveSessionSelector(stateDir, selector);
		if ("miss" in selected)
			return fail("runs", json, selected.miss.startsWith("no session") ? "not_found" : "ambiguous", selected.miss, 1);
		const rows = await readRuns(stateDir, selected.id);
		if (rows === null) return fail("runs", json, "not_found", `no session ${selected.id} in ${stateDir}`, 1);
		return emit(rows, json, printRuns);
	} catch (error) {
		return fail("runs", json, "io", `cannot read telemetry: ${errorText(error)}`, 1);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `argv` starts with the verb: `quota`, `health` or `runs`. */
export async function runTelemetrySnapshot(argv: ReadonlyArray<string>): Promise<number> {
	const [verb, ...rest] = argv;
	if (verb === "quota") return runQuota(rest);
	if (verb === "health") return runHealth(rest);
	if (verb === "runs") return runRuns(rest);
	writeCliFailure({
		path: ["telemetry"],
		slug: "unknown_command",
		message: `unknown telemetry command: ${verb ?? ""}`,
		json: argv.includes("--json"),
	});
	return 2;
}
