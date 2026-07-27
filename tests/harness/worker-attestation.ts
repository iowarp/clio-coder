/**
 * Attestation helpers for tests that stand up a stub worker entry.
 *
 * Stub entries are plain scripts written to a scratch dir, so they cannot
 * import the protocol module. `STUB_ANNOUNCE_SOURCE` is the snippet they
 * inline: it recomputes the spec digest from the bytes it received, which is
 * exactly what a real worker does and what the orchestrator checks.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/worker/protocol.js";

/**
 * Source for a `announceSpec(spec)` function plus its control-lane writer.
 * Inline this into a stub worker entry and call `announceSpec(spec)` after
 * parsing the WorkerSpec line.
 */
export const STUB_ANNOUNCE_SOURCE = `
const __crypto = require("node:crypto");
const __CONTROL_PREFIX = "@clio-control/1 ";
function __sha256(text) { return __crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function __canonical(value) {
	if (value === null) return "null";
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map((e) => (e === undefined ? "null" : __canonical(e))).join(",") + "]";
	if (typeof value === "object") {
		const parts = [];
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			parts.push(JSON.stringify(key) + ":" + __canonical(value[key]));
		}
		return "{" + parts.join(",") + "}";
	}
	return "null";
}
function __endpointHash(url) {
	if (url === undefined || String(url).trim().length === 0) return __sha256("clio.endpoint:none");
	const raw = String(url).trim();
	let canonical;
	try {
		const parsed = new URL(raw);
		canonical = parsed.protocol + "//" + parsed.hostname + ":" + parsed.port + parsed.pathname.replace(/\\/+$/, "");
	} catch { canonical = raw.replace(/\\/+$/, ""); }
	return __sha256("clio.endpoint:" + canonical);
}
function announceSpec(spec) {
	process.stderr.write(__CONTROL_PREFIX + JSON.stringify({
		kind: "announce",
		attestation: {
			protocolVersion: 1,
			specVersion: spec.specVersion,
			pid: process.pid,
			processGroupId: process.pid,
			host: "test",
			settingsFingerprint: spec.settingsFingerprint,
			specDigest: __sha256("clio.workerSpec:" + __canonical(spec)),
			runtimeId: spec.runtimeId,
			targetId: spec.target.id,
			endpointIdentityHash: __endpointHash(spec.target.url),
			wireModelId: spec.wireModelId,
			toolSignature: __sha256("clio.tools:" + [...(spec.allowedTools || [])].sort().join(",")),
			resources: {
				labels: [],
				cpuCount: { known: true, value: 4 },
				totalMemoryBytes: { known: true, value: 8589934592 },
				freeMemoryBytes: { known: true, value: 4294967296 },
				gpuCount: { known: false },
				vramBytes: { known: false },
				residentModels: { known: false },
			},
		},
	}) + "\\n");
}
`;

/** Settings fingerprint for a fixture that never reads real settings. */
export function fixtureSettingsFingerprint(seed = "test-settings"): string {
	return createHash("sha256")
		.update(`clio.settings:${canonicalJson({ seed })}`, "utf8")
		.digest("hex");
}
