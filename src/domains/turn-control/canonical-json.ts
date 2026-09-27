import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const fields = value as Record<string, unknown>;
		return `{${Object.keys(fields)
			.sort()
			.filter((key) => fields[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
