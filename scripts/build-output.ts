import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function buildVerbose(): boolean {
	return process.env.CLIO_CODER_BUILD_VERBOSE === "1";
}

export function buildColor(): boolean {
	return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

export function artifactBytes(directory: string, include: (file: string) => boolean = () => true): number {
	let bytes = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) bytes += artifactBytes(file, include);
		else if (entry.isFile() && include(file)) bytes += statSync(file).size;
	}
	return bytes;
}

export function reportBuildStage(label: string, startedAt: number, bytes: number): void {
	const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
	const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
	const mark = buildColor() ? "\x1b[32m✓\x1b[0m" : "✓";
	process.stdout.write(`${mark} ${label.padEnd(15)} ${elapsed.padStart(6)} s  ·  ${size}\n`);
}
