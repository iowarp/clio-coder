#!/usr/bin/env node
// `pnpm run check`: the fast pre-commit loop. Runs `pnpm run typecheck` (tsrs)
// and `biome check .` at once, prints each one's output as a block when it
// finishes, and fails if either fails. Biome shows errors only here; `pnpm run
// lint` also lists warnings and adds the slower hygiene checks, so run it
// before you report.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { root } from "./typecheck.mjs";

const require = createRequire(join(root, "package.json"));
const biome = join(dirname(require.resolve("@biomejs/biome/package.json")), "bin", "biome");
const steps = [
	["typecheck", [join(root, "scripts", "typecheck.mjs")]],
	["biome", [biome, "check", "--diagnostic-level=error", "."]],
];

const started = performance.now();
const results = await Promise.all(
	steps.map(
		([label, args]) =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
				let output = "";
				for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
				child.once("error", (error) => resolve({ label, code: 1, output: `${error.message}\n` }));
				child.once("close", (code, signal) => {
					const seconds = ((performance.now() - started) / 1000).toFixed(1);
					process.stdout.write(
						`── ${label}: ${code === 0 ? "ok" : `failed (${signal ?? `exit ${code}`})`} in ${seconds} s\n`,
					);
					if (output.trim()) process.stdout.write(`${output.trimEnd()}\n`);
					resolve({ label, code: code ?? 1 });
				});
			}),
	),
);
const failed = results.filter((result) => result.code !== 0).map((result) => result.label);
if (failed.length > 0) {
	process.stdout.write(`check: ${failed.join(" and ")} failed\n`);
	process.exitCode = 1;
}
