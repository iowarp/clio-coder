import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadManifestFromRoot } from "../discovery.js";
import { extensionContentDigestWithCapture } from "../integrity.js";
import type { ExtensionCapabilityEnvelope } from "../manifest-v2.js";
import { ExtensionRuntimeProcessV2 } from "../runtime-process-v2.js";
import { capabilityEnvelope, envelopeDigest } from "../runtime-schema-v2.js";
import { createMemoryExtensionKeyValueHost } from "../runtime-state.js";
import type { ExtensionDiagnostic, LoadableExtension } from "../types.js";

const EXECUTION_NOTICE =
	"Registration check executes the package's startup code in a private copy under its declared Node permissions. Permissions are a seat belt, not a sandbox; network restrictions are not enforced. No activation or handler invocation occurs.";

export interface ExtensionValidationReport {
	path: string;
	valid: boolean;
	diagnostics: ExtensionDiagnostic[];
	envelope: ExtensionCapabilityEnvelope | null;
	envelopeDigest: string | null;
	registration: {
		status: "passed" | "failed" | "skipped";
		notice: string;
		actions?: readonly string[];
		interviews?: readonly string[];
		reason?: string;
	};
}

export async function validateExtensionPackage(root: string): Promise<ExtensionValidationReport> {
	const path = resolve(root);
	const candidate = loadManifestFromRoot(path);
	const declaration = candidate.manifest?.runtimeV2;
	const envelope = declaration ? capabilityEnvelope(declaration, candidate.manifest?.plugin) : null;
	const report: ExtensionValidationReport = {
		path,
		valid: candidate.valid,
		diagnostics: [...candidate.diagnostics],
		envelope,
		envelopeDigest: envelope ? envelopeDigest(envelope) : null,
		registration: {
			status: "skipped",
			notice: EXECUTION_NOTICE,
			reason: candidate.valid ? "no api 2 runtime declared" : "discovery reported errors",
		},
	};
	if (!candidate.valid || !candidate.manifest || !candidate.manifestPath || !declaration) return report;
	let scratch: string | undefined;
	let child: ExtensionRuntimeProcessV2 | undefined;
	try {
		const canonicalRoot = realpathSync(path);
		const extension: LoadableExtension = {
			...candidate.manifest,
			scope: "user",
			rootPath: canonicalRoot,
			manifestPath: candidate.manifestPath,
			enabled: true,
			valid: true,
			compatible: true,
			effective: true,
			loadable: true,
			diagnostics: [],
			provenance: {
				id: candidate.manifest.id,
				scope: "user",
				canonicalRoot,
				manifestDigest: createHash("sha256").update(readFileSync(candidate.manifestPath)).digest("hex"),
				contentDigest: extensionContentDigestWithCapture(canonicalRoot).digest,
			},
		};
		scratch = mkdtempSync(join(tmpdir(), "clio-coder-author-validate-"));
		child = new ExtensionRuntimeProcessV2(extension, {
			snapshot: {
				workspace: realpathSync(process.cwd()),
				sessionId: null,
				generation: 1,
				mode: "headless",
				activeWorkspace: null,
			},
			options: Object.fromEntries(declaration.config.map((field) => [field.key, field.default])),
			keyValue: createMemoryExtensionKeyValueHost(),
			storeDir: join(scratch, "store"),
		});
		await child.staged;
		report.registration = {
			status: "passed",
			notice: EXECUTION_NOTICE,
			actions: child.actions,
			interviews: child.interviews,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		report.valid = false;
		report.diagnostics.push({ type: "error", message: `registration: ${reason}`, path: candidate.manifestPath });
		report.registration = { status: "failed", notice: EXECUTION_NOTICE, reason };
	} finally {
		try {
			await child?.dispose("author-validation");
		} finally {
			if (scratch) rmSync(scratch, { recursive: true, force: true });
		}
	}
	return report;
}
