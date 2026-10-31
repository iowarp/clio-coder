import { readFile } from "node:fs/promises";
import { clioStateDir } from "../core/xdg.js";
import { telemetryImportedStateDir } from "../domains/telemetry/paths.js";
import { seal } from "../domains/telemetry/read-model.js";
import type { SealVerdict } from "../domains/telemetry/seal.js";
import { describeSealMismatch, readTelemetryScopeFiles } from "../domains/telemetry/seal.js";
import { printError } from "./shared.js";
import { resolveTelemetryTarget } from "./telemetry-target.js";

const HELP = `clio-coder telemetry verify <session | scope-dir | archive> [--imported <install-id>] [--json]
clio-coder telemetry verify --run <run-id> [--imported <install-id>] [--json]
`;

function describe(path: string, verdict: SealVerdict): string {
	if (verdict.status === "unsealed")
		return `unsealed ${path}: ${verdict.reason === "no-journal" ? "no journal" : "no bundle.json (live or never sealed)"}`;
	if (verdict.status === "failed") return `failed ${path}: ${describeSealMismatch(verdict.mismatch)}`;
	return `verified ${verdict.scope.kind} ${verdict.scope.id}: sealed ${verdict.sealedAt}, ${verdict.records} lines in ${verdict.segments} segment(s), ${verdict.objects} object(s), head ${verdict.seal.head}`;
}

/** A share archive verifies as a whole: its manifest, then every bundle it carries (#434). */
async function verifyArchive(path: string, json: boolean): Promise<number> {
	const { verifyShareArchive } = await import("../domains/telemetry/share.js");
	const check = verifyShareArchive(await readFile(path));
	if (json) {
		const scopes = check.scopes.map(({ kind, id, verdict }) => ({ kind, id, ...verdict }));
		process.stdout.write(
			`${JSON.stringify({ path, archive: true, status: check.failure === null ? "verified" : "failed", failure: check.failure, manifest: check.manifest, scopes }, null, 2)}\n`,
		);
	} else {
		for (const scope of check.scopes) process.stdout.write(`${describe(`${scope.kind} ${scope.id}`, scope.verdict)}\n`);
		const manifest = check.manifest;
		process.stdout.write(
			check.failure === null && manifest
				? `verified archive ${path}: ${manifest.scopes.length} scope(s), profile ${manifest.profile}, source ${manifest.installId}, Clio ${manifest.clioCoderVersion}\n`
				: `failed archive ${path}: ${check.failure}\n`,
		);
	}
	return check.failure === null ? 0 : 1;
}

/** Exit 0 verified, 1 failed or unsealed, 2 on usage errors (#434). */
export async function runTelemetryVerify(argv: ReadonlyArray<string>): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	let json = false;
	let target: string | undefined;
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--json") json = true;
		else if (
			(arg === "--run" || arg === "--imported") &&
			!values.has(arg) &&
			argv[index + 1] !== undefined &&
			!argv[index + 1]?.startsWith("-")
		) {
			values.set(arg, argv[index + 1] as string);
			index += 1;
		} else if (!arg.startsWith("-") && target === undefined) target = arg;
		else {
			process.stderr.write(HELP);
			return 2;
		}
	}
	const runId = values.get("--run");
	if ((target === undefined) === (runId === undefined)) {
		process.stderr.write(HELP);
		return 2;
	}
	let path: string;
	try {
		const imported = values.get("--imported");
		const stateDir = imported === undefined ? clioStateDir() : telemetryImportedStateDir(clioStateDir(), imported);
		const resolved = resolveTelemetryTarget(
			stateDir,
			(runId ?? target) as string,
			runId === undefined ? "session" : "run",
		);
		path = resolved.path;
		if (resolved.kind === "archive") return await verifyArchive(path, json);
		if (!resolved.exists) {
			printError(`no telemetry scope for ${runId ?? target} at ${path}`);
			return 2;
		}
	} catch (error) {
		printError(`cannot read telemetry ${runId ?? target}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	let verdict: SealVerdict;
	try {
		verdict = seal(await readTelemetryScopeFiles(path));
	} catch (error) {
		printError(`cannot read telemetry scope ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	process.stdout.write(json ? `${JSON.stringify({ path, ...verdict }, null, 2)}\n` : `${describe(path, verdict)}\n`);
	return verdict.status === "verified" ? 0 : 1;
}
