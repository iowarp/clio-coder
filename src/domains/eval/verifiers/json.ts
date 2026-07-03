import { readFile } from "node:fs/promises";

export async function readJsonFile(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export function jsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "" || pointer === "/") return value;
	let current = value;
	for (const rawPart of pointer.split("/").slice(1)) {
		const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}
