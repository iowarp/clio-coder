import { resolve } from "node:path";
import { seal } from "../domains/telemetry/read-model.js";
import type { SealMismatch, SealVerdict } from "../domains/telemetry/seal.js";
import { readTelemetryScopeFiles } from "../domains/telemetry/seal.js";
import { printError } from "./shared.js";

function describeMismatch(mismatch: SealMismatch): string {
	switch (mismatch.kind) {
		case "manifest":
		case "seal":
			return `${mismatch.kind}: ${mismatch.detail}`;
		case "segment":
		case "object":
			return `${mismatch.kind} ${mismatch.name}: ${mismatch.detail}`;
		case "chain":
			return `chain at ${mismatch.name} line ${mismatch.line}: ${mismatch.detail}`;
	}
}

function describe(path: string, verdict: SealVerdict): string {
	if (verdict.status === "unsealed")
		return `unsealed ${path}: ${verdict.reason === "no-journal" ? "no journal" : "no bundle.json (live or never sealed)"}`;
	if (verdict.status === "failed") return `failed ${path}: ${describeMismatch(verdict.mismatch)}`;
	return `verified ${verdict.scope.kind} ${verdict.scope.id}: sealed ${verdict.sealedAt}, ${verdict.records} lines in ${verdict.segments} segment(s), ${verdict.objects} object(s), head ${verdict.seal.head}`;
}

/** `telemetry verify <path> [--json]`: exit 0 verified, 1 failed or unsealed, 2 on usage errors (#434). */
export async function runTelemetryVerify(argv: ReadonlyArray<string>): Promise<number> {
	const json = argv.includes("--json");
	const paths = argv.filter((arg) => arg !== "--json");
	if (paths.length !== 1 || paths[0]?.startsWith("-")) {
		printError("usage: clio-coder telemetry verify <scope-dir> [--json]");
		return 2;
	}
	const path = resolve(paths[0] as string);
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
