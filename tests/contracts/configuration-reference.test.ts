import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";

it("checks configuration rows through real hygiene in a disposable package fixture", () => {
	const root = resolve(import.meta.dirname, "../..");
	const fixture = mkdtempSync(join(tmpdir(), "clio-coder-configuration-reference-"));
	try {
		// Use the same source inventory as hygiene. Copying whole directories also
		// copies ignored nested dependencies, build output and operator scratch.
		const sources = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
		for (const file of new Set(sources.split("\0").filter(Boolean))) {
			const source = join(root, file);
			const info = lstatSync(source, { throwIfNoEntry: false });
			if (!info || info.isDirectory()) continue;
			const destination = join(fixture, file);
			mkdirSync(dirname(destination), { recursive: true });
			if (info.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
			else copyFileSync(source, destination);
		}
		for (const entry of ["node_modules", ".git", "dist"]) {
			symlinkSync(join(root, entry), join(fixture, entry));
		}
		strictEqual(existsSync(join(fixture, "apps/clio-coder-web/node_modules")), false);
		strictEqual(existsSync(join(fixture, "apps/clio-coder-web/dist")), false);
		const docPath = join(fixture, "docs/guide/configuration-reference.md");
		const original = readFileSync(docPath, "utf8");
		const cases = [
			{
				paths: [
					"context.compaction.model",
					"fleet.profiles.<key>.node",
					"targets[].auth.headers.<key>",
					"fleet.rosters.<key>.members[].model",
				],
				stale: false,
			},
			{
				paths: [
					"chat.obsoleteOption",
					"context.compaction.obsoleteOption",
					"targets[].capabilities.obsoleteOption",
					"fleet.profiles.<key>.obsoleteOption",
					"fleet.rosters.<key>.members[].obsoleteOption",
					"chat.model.obsoleteOption",
					"chat[].model",
					"chat.<key>.model",
				],
				stale: true,
			},
		];
		for (const scenario of cases) {
			writeFileSync(
				docPath,
				original.replace(
					"## Settings keys",
					`## Settings keys\n${scenario.paths.map((path) => `| \`${path}\` | fixture |`).join("\n")}`,
				),
			);
			const result = spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/check-hygiene.ts")], {
				cwd: root,
				env: { ...process.env, CLIO_CODER_PACKAGE_ROOT: fixture },
				encoding: "utf8",
				timeout: 120_000,
			});
			strictEqual(result.error, undefined);
			const output = result.stdout + result.stderr;
			strictEqual(result.status, scenario.stale ? 1 : 0, output);
			for (const path of scenario.paths) {
				strictEqual(output.includes(`\n  ${path}\n`), scenario.stale, output);
			}
		}
		strictEqual(readFileSync(join(root, "docs/guide/configuration-reference.md"), "utf8"), original);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
