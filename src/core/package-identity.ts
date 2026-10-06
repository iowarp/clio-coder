export interface PackageIdentity {
	kind: string;
	id: string;
	version: string;
	digest: string;
	scope?: string;
	envelopeDigest?: string;
}

export function isPackageIdentity(value: unknown): value is PackageIdentity {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		["kind", "id", "version", "digest"].every((key) => typeof item[key] === "string") &&
		(item.scope === undefined || typeof item.scope === "string") &&
		(item.envelopeDigest === undefined || typeof item.envelopeDigest === "string")
	);
}
