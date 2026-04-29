import { createHash } from "node:crypto";

export function sha256Hex(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function stableJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (isRecord(value)) {
		const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
