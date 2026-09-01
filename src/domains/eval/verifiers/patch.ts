import { spawnSync } from "node:child_process";

export interface PatchMetrics {
	bytes: number;
	filesChanged: number;
	testFilesModified: number;
}

export function collectPatchMetrics(cwd: string): PatchMetrics {
	const diff = spawnSync("git", ["diff", "--", "."], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const text = diff.status === 0 && typeof diff.stdout === "string" ? diff.stdout : "";
	const files = text
		.split(/\r?\n/)
		.filter((line) => line.startsWith("diff --git "))
		.map((line) => line.split(" b/")[1] ?? "");
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		filesChanged: files.length,
		testFilesModified: files.filter((file) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(file))
			.length,
	};
}
