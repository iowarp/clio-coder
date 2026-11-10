import { scanTelemetrySegment } from "../../../core/telemetry/segment.js";
import { ALL_TOOL_NAMES } from "../../../core/tool-names.js";
import { carriesPath, unpackTelemetryArchive, verifyShareArchive } from "../../telemetry/index.js";
import { reportOs } from "../vocabulary.js";

/**
 * The content-free digest a share carries beside its archive (share intake contract v1): counts over closed
 * vocabularies only, so the maintainers' metrics can be derived without opening the archive. Operator tools collapse
 * into "other" and a model id that is anonymized or looks like a path counts as "anon".
 */
export interface ShareDigest {
	v: 1;
	os?: string;
	install: string;
	profile: string;
	scopes: { session: number; run: number; process: number };
	records: number;
	events: Record<string, number>;
	failureCauses: Record<string, number>;
	dispositions: Record<string, number>;
	tools: Record<string, { ok: number; error: number; denied: number }>;
	runTerminal: Record<string, number>;
	models: Record<string, number>;
}

const BUILTIN_TOOLS: ReadonlySet<string> = new Set(ALL_TOOL_NAMES);

function bump(counts: Record<string, number>, key: unknown): void {
	if (typeof key !== "string" || key.length === 0) return;
	counts[key] = (counts[key] ?? 0) + 1;
}

function field(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Digest a telemetry share archive; it throws when the archive does not verify. */
export function telemetryShareDigest(
	archive: Buffer,
	facts: { platform: NodeJS.Platform | string; install: string; profile: string },
): ShareDigest {
	const check = verifyShareArchive(archive);
	if (check.failure !== null) throw new Error(`the share archive does not verify: ${check.failure}`);
	const os = reportOs(facts.platform as NodeJS.Platform);
	const digest: ShareDigest = {
		v: 1,
		...(os !== null ? { os } : {}),
		install: facts.install,
		profile: facts.profile,
		scopes: { session: 0, run: 0, process: 0 },
		records: 0,
		events: {},
		failureCauses: {},
		dispositions: {},
		tools: {},
		runTerminal: {},
		models: {},
	};
	for (const scope of check.scopes) {
		digest.scopes[scope.kind] += 1;
		for (const segment of scope.files.segments)
			for (const row of scanTelemetrySegment(segment.bytes).rows) {
				if (row.kind !== "record") continue;
				const { k, data } = row.record;
				digest.records += 1;
				bump(digest.events, k);
				if (k === "call.settled") {
					bump(digest.dispositions, field(data, "disposition"));
					bump(digest.failureCauses, field(data, "stop", "failure"));
					const model = field(data, "target", "requestedModel");
					if (typeof model === "string")
						bump(digest.models, model.startsWith("anon_") || carriesPath(model) ? "anon" : model);
				} else if (k === "run.settled") bump(digest.runTerminal, field(data, "terminalReason"));
				else if (k === "tool.settled") {
					const tool = field(data, "tool");
					const name = typeof tool === "string" && BUILTIN_TOOLS.has(tool) ? tool : "other";
					const outcome = field(data, "outcome");
					const tally = digest.tools[name] ?? { ok: 0, error: 0, denied: 0 };
					if (outcome === "ok") tally.ok += 1;
					else if (outcome === "error") tally.error += 1;
					else if (outcome === "blocked") tally.denied += 1;
					digest.tools[name] = tally;
				}
			}
	}
	return digest;
}

/** Digest a report bundle: its envelope names the platform and install kind, its telemetry member is a share archive. */
export function reportBundleDigest(bundle: Buffer): ShareDigest {
	const entries = unpackTelemetryArchive(bundle);
	const envelope = entries.find((entry) => entry.path === "report.json");
	const telemetry = entries.find((entry) => entry.path === "telemetry.tar.gz");
	if (envelope === undefined || telemetry === undefined) throw new Error("not a report bundle");
	const environment = field(JSON.parse(envelope.bytes.toString("utf8")), "environment");
	const platform = field(environment, "platform");
	const install = field(environment, "install");
	return telemetryShareDigest(telemetry.bytes, {
		platform: typeof platform === "string" ? (platform.split("-")[0] ?? "") : "",
		install: typeof install === "string" ? install : "unknown",
		profile: "report",
	});
}
