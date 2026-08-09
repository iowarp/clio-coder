import { readFile } from "node:fs/promises";

export async function readJsonFile(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}
