import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { runCommandVector } from "../../../core/safe-exec.js";
import { clioCacheDir, clioConfigDir, clioDataDir, clioStateDir } from "../../../core/xdg.js";

export async function testExtensionPackage(root: string): Promise<number> {
	const path = realpathSync(root);
	const files = readdirSync(path, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".test.ts") &&
				!join(entry.parentPath, entry.name)
					.slice(path.length + 1)
					.split(/[\\/]/)
					.some((part) => part === "node_modules" || part === ".git"),
		)
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
	if (files.length === 0) throw new Error(`no **/*.test.ts files in ${path}`);
	const result = await runCommandVector(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			join(resolvePackageRoot(), "src/domains/extensions/authoring/test-register.mjs"),
			"--test",
			...files,
		],
		{
			cwd: path,
			workspaceRoot: path,
			timeoutMs: 120000,
			env: {
				CLIO_CODER_CONFIG_DIR: clioConfigDir(),
				CLIO_CODER_DATA_DIR: clioDataDir(),
				CLIO_CODER_STATE_DIR: clioStateDir(),
				CLIO_CODER_CACHE_DIR: clioCacheDir(),
				...(process.env.CLIO_CODER_HOME === undefined ? {} : { CLIO_CODER_HOME: process.env.CLIO_CODER_HOME }),
			},
			output: { onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk) },
		},
	);
	if (result.failure || result.timedOut || result.aborted || result.sinkError) {
		process.stderr.write(
			`extension tests did not complete: ${result.failure ?? result.sinkError ?? (result.timedOut ? "timed out" : "aborted")}\n`,
		);
	}
	return result.exitCode ?? 1;
}
