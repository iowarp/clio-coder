import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { storeRoot } from "../../core/store-paths.js";
import type { StoreBackend } from "./backend.js";
import { CLIO_CORE_CHAIN_TOP_POOL, createClioCoreStoreBackend } from "./backends/clio-core.js";
import { type CoreHost, startCoreHost } from "./core-host/supervisor.js";
import { StoreRefusal } from "./types.js";

/**
 * Which backend the store uses, chosen by the operator with
 * `clio-coder store backend` and recorded in `<dataDir>/store/backend.json`.
 * No record means local. A clio-core record never falls back to local: data
 * written to the wrong backend is worse than an error.
 */
export interface StoreBackendRecord {
	v: 1;
	backend: "local" | "clio-core";
	python?: string;
	config?: string;
	pool?: string;
	mount?: string;
	stopIfLast?: boolean;
}

export type ClioCoreSelection = Omit<StoreBackendRecord, "v" | "backend">;

export interface StoreBackendSelection {
	path: string;
	/** null: local, either because no record exists or because the record could not be used (`problem`). */
	record: StoreBackendRecord | null;
	problem: string | null;
}

export interface StoreProbeRow {
	name: string;
	ok: boolean;
	detail: string;
	/** Informational rows never block selecting the backend. */
	info?: boolean;
}

const CLIO_CORE_DEFAULT_PORT = 9413;
const PIP_PACKAGE = "iowarp-core";
const DAEMON_CONNECT_MS = 2000;
const ENSURE_TIMEOUT_MS = 60_000;
const RELEASE_TIMEOUT_MS = 5000;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function storeBackendRecordPath(): string {
	return path.join(storeRoot(), "backend.json");
}

function parseRecord(value: unknown): StoreBackendRecord | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not a JSON object";
	const raw = value as Record<string, unknown>;
	if (raw.v !== 1) return `it has version ${JSON.stringify(raw.v)}; this Clio Coder reads version 1`;
	if (raw.backend !== "local" && raw.backend !== "clio-core")
		return `its backend ${JSON.stringify(raw.backend)} is neither "local" nor "clio-core"`;
	const record: StoreBackendRecord = { v: 1, backend: raw.backend };
	for (const key of ["python", "config", "pool", "mount"] as const) {
		const field = raw[key];
		if (field === undefined) continue;
		if (typeof field !== "string" || field === "") return `its ${key} is not a non-empty string`;
		record[key] = field;
	}
	if (raw.stopIfLast !== undefined) {
		if (typeof raw.stopIfLast !== "boolean") return "its stopIfLast is not a boolean";
		record.stopIfLast = raw.stopIfLast;
	}
	return record;
}

export function readStoreBackendSelection(): StoreBackendSelection {
	const file = storeBackendRecordPath();
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, record: null, problem: null };
		return { path: file, record: null, problem: `${file} is unreadable (${messageOf(error)}); using the local backend` };
	}
	let parsed: StoreBackendRecord | string;
	try {
		parsed = parseRecord(JSON.parse(text));
	} catch (error) {
		parsed = `it is not valid JSON (${messageOf(error)})`;
	}
	if (typeof parsed === "string")
		return { path: file, record: null, problem: `${file} is ignored: ${parsed}; using the local backend` };
	return { path: file, record: parsed, problem: null };
}

export async function writeStoreBackendRecord(record: StoreBackendRecord): Promise<void> {
	await safeResourceWriteAsync(storeBackendRecordPath(), `${JSON.stringify(record, null, 2)}\n`);
}

export async function removeStoreBackendRecord(): Promise<void> {
	await rm(storeBackendRecordPath(), { force: true });
}

function executable(file: string): boolean {
	try {
		accessSync(file, fsConstants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

export function onPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, name);
		if (executable(candidate)) return candidate;
	}
	return null;
}

/** The interpreter given, else the one beside a `clio_run` on PATH; `clio_run` beside the interpreter, else on PATH. */
function resolveClioCoreTools(python: string | undefined): { python: string | null; clioRun: string | null } {
	const clioRunOnPath = onPath("clio_run");
	if (python !== undefined) {
		const beside = path.join(path.dirname(python), "clio_run");
		return { python, clioRun: executable(beside) ? beside : clioRunOnPath };
	}
	if (clioRunOnPath === null) return { python: null, clioRun: null };
	const dir = path.dirname(clioRunOnPath);
	const found = ["python3", "python"].map((name) => path.join(dir, name)).find(executable) ?? null;
	return { python: found, clioRun: clioRunOnPath };
}

/** clio-core's config variable. Clio Coder never reads it; it only hands the record's config to `clio_run`. */
const CLIO_CORE_CONFIG_KEY = "CLIO_SERVER_CONF";

/** PATH, HOME and USER, plus clio-core's config variable when the record names a config. Nothing else is inherited. */
function toolEnv(config: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "USER"] as const) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (config !== undefined) env[CLIO_CORE_CONFIG_KEY] = config;
	return env;
}

interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error: string | null;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{ env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
				resolve({ code, stdout: String(stdout), stderr: String(stderr), error: error === null ? null : error.message });
			},
		);
	});
}

function lastJsonLine(text: string): Record<string, unknown> | null {
	for (const line of text.trim().split("\n").reverse()) {
		try {
			const value = JSON.parse(line) as unknown;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {
			// Not the JSON line; keep looking upward.
		}
	}
	return null;
}

function tail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 400 ? `...${trimmed.slice(-400)}` : trimmed;
}

async function wheelVersion(python: string): Promise<{ version: string } | { error: string }> {
	const result = await run(
		python,
		["-c", "import sys, iowarp_core; sys.stdout.write(str(iowarp_core.__version__))"],
		toolEnv(undefined),
		30_000,
	);
	if (result.code === 0 && result.stdout.trim() !== "") return { version: result.stdout.trim() };
	return { error: tail(result.stderr) || result.error || `exit ${result.code}` };
}

const ensureSupport = new Map<string, Promise<boolean>>();

/** U-12: a build whose `clio_run ensure --help` succeeds has the shared lifecycle; any other build is attached to only. */
function hasEnsure(clioRun: string): Promise<boolean> {
	let known = ensureSupport.get(clioRun);
	if (known === undefined) {
		known = run(clioRun, ["ensure", "--help"], toolEnv(undefined), 10_000).then((result) => result.code === 0);
		ensureSupport.set(clioRun, known);
	}
	return known;
}

function storeClientId(): string {
	return `clio-coder-${process.pid}`;
}

type EnsureOutcome =
	| { kind: "ok"; port: number; version: string; action: string }
	| { kind: "refused"; daemonVersion: string; version: string }
	| { kind: "failed"; message: string };

const registered = new Set<string>();

/** Released once, synchronously, as this process exits; never `--stop-if-last` unless the record asks for it. */
function releaseOnExit(clioRun: string, config: string | undefined, stopIfLast: boolean): void {
	const key = `${clioRun}\0${config ?? ""}`;
	if (registered.has(key)) return;
	registered.add(key);
	process.once("exit", () => {
		spawnSync(
			clioRun,
			[
				"release",
				"--client",
				storeClientId(),
				...(config !== undefined ? ["--config", config] : []),
				...(stopIfLast ? ["--stop-if-last"] : []),
			],
			{ env: toolEnv(config), timeout: RELEASE_TIMEOUT_MS, stdio: "ignore", windowsHide: true },
		);
	});
}

async function ensureDaemon(clioRun: string, selection: ClioCoreSelection): Promise<EnsureOutcome> {
	const args = ["ensure", "--client", storeClientId(), "--json"];
	if (selection.config !== undefined) args.push("--config", selection.config);
	const result = await run(clioRun, args, toolEnv(selection.config), ENSURE_TIMEOUT_MS);
	const json = lastJsonLine(result.stdout);
	if (json?.action === "refused")
		return { kind: "refused", daemonVersion: String(json.daemon_version), version: String(json.version) };
	if (result.code === 0 && json !== null && typeof json.port === "number") {
		releaseOnExit(clioRun, selection.config, selection.stopIfLast === true);
		return { kind: "ok", port: json.port, version: String(json.version), action: String(json.action) };
	}
	return { kind: "failed", message: tail(result.stderr) || result.error || `exit ${result.code}` };
}

/** U-12 `clio_run status --json`: the daemon record's version, when there is one. Starts nothing. */
async function statusVersion(clioRun: string, config: string | undefined): Promise<string | null> {
	const result = await run(clioRun, ["status", "--json"], toolEnv(config), 15_000);
	const version = lastJsonLine(result.stdout)?.version;
	return typeof version === "string" && version !== "" ? version : null;
}

/**
 * `networking.port` of the record's clio-core config, else clio-core's default.
 * Without a config Clio Coder does not read clio-core's own default config
 * under the home directory; a daemon on another port needs `--config`.
 */
function clioCoreDaemonPort(config: string | undefined): number {
	if (config === undefined) return CLIO_CORE_DEFAULT_PORT;
	try {
		const parsed = parseYaml(readFileSync(config, "utf8")) as { networking?: { port?: unknown } } | null;
		const port = parsed?.networking?.port;
		if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) return port;
	} catch {
		// An unreadable config: the host reports it; the daemon is looked for on the default port.
	}
	return CLIO_CORE_DEFAULT_PORT;
}

function daemonAnswers(port: number, timeoutMs = DAEMON_CONNECT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const done = (ok: boolean): void => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

function startCommand(config: string | undefined): string {
	return config === undefined ? "clio_run start" : `CLIO_SERVER_CONF=${config} clio_run start`;
}

export interface ClioCoreAttach {
	rows: StoreProbeRow[];
	host: CoreHost | null;
}

/**
 * The probe and the attach are one sequence. Each step adds a row; the first
 * failing required row stops it. With `ensure` the daemon is attached or
 * started through `clio_run ensure`; without it Clio Coder only attaches, and
 * no code path here starts, stops or signals `clio_run`. `startDaemon: false`
 * (doctor, `store backend` with no argument) never calls `ensure`: it reads
 * `clio_run status --json` instead, and a stopped daemon that the first store
 * op would start ends the probe with an informational row and no host.
 */
export async function attachClioCore(
	selection: ClioCoreSelection,
	options: { checkWheel: boolean; startDaemon?: boolean },
): Promise<ClioCoreAttach> {
	const startDaemon = options.startDaemon !== false;
	const rows: StoreProbeRow[] = [];
	const fail = (name: string, detail: string): ClioCoreAttach => {
		rows.push({ name, ok: false, detail });
		return { rows, host: null };
	};
	const tools = resolveClioCoreTools(selection.python);
	if (tools.python === null)
		return fail(
			"interpreter",
			`no interpreter: none was given and no clio_run is on PATH. Install the wheel (pip install ${PIP_PACKAGE}) and pass --python <interpreter>.`,
		);
	let wheel: string | null = null;
	if (options.checkWheel) {
		const found = await wheelVersion(tools.python);
		if ("error" in found)
			return fail(
				"interpreter",
				`${tools.python} cannot import iowarp_core (${found.error}). Install it there: ${tools.python} -m pip install ${PIP_PACKAGE}`,
			);
		wheel = found.version;
		rows.push({ name: "interpreter", ok: true, detail: `${tools.python}, iowarp-core ${wheel}` });
	}

	const lifecycle = tools.clioRun !== null && (await hasEnsure(tools.clioRun));
	rows.push({
		name: "lifecycle",
		ok: true,
		info: true,
		detail: lifecycle
			? `clio_run ensure and release (${tools.clioRun}); client ${storeClientId()}${selection.stopIfLast === true ? ", stops the daemon when last" : ""}`
			: `attach only: ${tools.clioRun ?? "no clio_run"} has no ensure; Clio Coder never starts or stops the daemon`,
	});

	let port = clioCoreDaemonPort(selection.config);
	let daemonVersion: string | null = null;
	if (lifecycle && tools.clioRun !== null && startDaemon) {
		const ensured = await ensureDaemon(tools.clioRun, selection);
		if (ensured.kind === "refused")
			return fail(
				"daemon version",
				`the running daemon is ${ensured.daemonVersion} but ${tools.clioRun} is ${ensured.version}; stop it or use a matching build`,
			);
		if (ensured.kind === "failed") return fail("daemon", `clio_run ensure failed: ${ensured.message}`);
		port = ensured.port;
		daemonVersion = ensured.version;
	}
	const answers = await daemonAnswers(port);
	if (!answers && lifecycle && !startDaemon) {
		rows.push({
			name: "daemon",
			ok: true,
			info: true,
			detail: `not running on 127.0.0.1:${port}; the first store op starts it through clio_run ensure`,
		});
		return { rows, host: null };
	}
	if (lifecycle && tools.clioRun !== null && !startDaemon && answers)
		daemonVersion = await statusVersion(tools.clioRun, selection.config);
	if (!answers)
		return fail(
			"daemon",
			lifecycle
				? `clio_run ensure reported port ${port}, but nothing answers on 127.0.0.1:${port}`
				: `nothing answers on 127.0.0.1:${port} within ${DAEMON_CONNECT_MS / 1000} s. Start it yourself (${startCommand(selection.config)})${selection.config === undefined ? ", or pass --config <yaml> if it listens on another port" : ""}`,
		);
	rows.push({ name: "daemon", ok: true, detail: `answering on 127.0.0.1:${port}` });
	if (daemonVersion !== null && wheel !== null && daemonVersion !== wheel)
		return fail("daemon version", `the daemon is ${daemonVersion} but the wheel is ${wheel}; they must match`);
	rows.push({
		name: "daemon version",
		ok: true,
		...(daemonVersion === null ? { info: true } : {}),
		detail:
			daemonVersion ?? (lifecycle ? "not reported (no daemon record)" : "not reported (this clio_run has no ensure)"),
	});

	const pool = selection.pool ?? CLIO_CORE_CHAIN_TOP_POOL;
	let host: CoreHost;
	try {
		host = await startCoreHost({
			command: tools.python,
			args: [
				path.join(resolvePackageRoot(), "assets", "core-host", "clio_core_host.py"),
				"--pool",
				pool,
				...(selection.config !== undefined ? ["--config", selection.config] : []),
			],
		});
	} catch (error) {
		return fail("host", messageOf(error));
	}
	const hello = host.hello;
	const coreVersion = hello?.coreVersion ?? "unknown";
	const missing = hello?.missing ?? [];
	if (daemonVersion !== null && coreVersion !== daemonVersion) {
		await host.close();
		return fail("host", `the host's iowarp-core is ${coreVersion} but the daemon is ${daemonVersion}; they must match`);
	}
	rows.push({
		name: "host",
		ok: true,
		detail: `hello: iowarp-core ${coreVersion}, pool ${hello?.pool ?? pool}; missing ${missing.length === 0 ? "nothing" : missing.join(", ")}`,
	});
	try {
		const facts = await host.call("facts", {});
		if (!facts.durable) {
			await host.close();
			return fail(
				"durable",
				"no durable tier: data would not survive a restart. Give clio_cte_core a file tier with persistence_level long_term.",
			);
		}
		rows.push({ name: "durable", ok: true, detail: "yes" });
	} catch (error) {
		await host.close();
		return fail("durable", messageOf(error));
	}
	return { rows, host };
}

function clioCoreAttachFailure(attach: ClioCoreAttach): StoreRefusal {
	const row = attach.rows.find((candidate) => !candidate.ok);
	return new StoreRefusal(
		"unavailable",
		`The clio-core store backend is unavailable (${row?.name ?? "attach"}): ${(row?.detail ?? "unknown failure").replace(/(?<![.!?])$/u, ".")} ` +
			"Store operations stay off until it attaches; `clio-coder store backend local` switches back without moving data.",
	);
}

let attached: { key: string; host: Promise<CoreHost> } | null = null;

/** One host per process and record, started on the first store op; a failed attach is retried on the next op. */
export async function openClioCoreBackend(cwd: string, record: StoreBackendRecord): Promise<StoreBackend> {
	const key = JSON.stringify(record);
	if (attached !== null && attached.key !== key) {
		const stale = attached.host;
		attached = null;
		await stale.then((host) => host.close()).catch(() => undefined);
	}
	if (attached === null) {
		const pending = attachClioCore(record, { checkWheel: false }).then((attach) => {
			if (attach.host === null) throw clioCoreAttachFailure(attach);
			return attach.host;
		});
		const entry = { key, host: pending };
		attached = entry;
		pending.catch(() => {
			if (attached === entry) attached = null;
		});
	}
	const current = attached;
	const host = await current.host;
	if (host.state === "closed") {
		if (attached === current) attached = null;
		return openClioCoreBackend(cwd, record);
	}
	return createClioCoreStoreBackend(cwd, host, {
		...(record.pool !== undefined ? { pool: record.pool } : {}),
		...(record.mount !== undefined ? { mount: record.mount } : {}),
	});
}
