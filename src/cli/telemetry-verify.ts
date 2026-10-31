import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { seal } from "../domains/telemetry/read-model.js";
import type { SealVerdict } from "../domains/telemetry/seal.js";
import { describeSealMismatch, readTelemetryScopeFiles } from "../domains/telemetry/seal.js";
import { printError } from "./shared.js";

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

/** `telemetry verify <path> [--json]`: exit 0 verified, 1 failed or unsealed, 2 on usage errors (#434). */
export async function runTelemetryVerify(argv: ReadonlyArray<string>): Promise<number> {
	const json = argv.includes("--json");
	const paths = argv.filter((arg) => arg !== "--json");
	if (paths.length !== 1 || paths[0]?.startsWith("-")) {
		printError("usage: clio-coder telemetry verify <scope-dir | archive> [--json]");
		return 2;
	}
	const path = resolve(paths[0] as string);
	try {
		if ((await lstat(path)).isFile()) return await verifyArchive(path, json);
	} catch (error) {
		printError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
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
