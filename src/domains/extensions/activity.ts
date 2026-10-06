import type { PackageIdentity } from "../../core/package-identity.js";
import { capabilityEnvelope, envelopeDigest } from "./runtime-schema-v2.js";
import type { InstalledExtension } from "./types.js";

export function extensionIdentity(entry: InstalledExtension): PackageIdentity {
	return {
		kind: "extension",
		id: entry.id,
		version: entry.version,
		digest: entry.provenance?.contentDigest ?? "",
		scope: entry.scope,
		...(entry.runtimeV2 ? { envelopeDigest: envelopeDigest(capabilityEnvelope(entry.runtimeV2, entry.plugin)) } : {}),
	};
}
