/**
 * Contracts for scripts/install.sh, the curl-able installer that brings its
 * own Node. Only --dry-run runs here: it stops before any download or write,
 * so nothing reaches the network or a real home.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "install.sh");

function run(args: string[]) {
	const home = mkdtempSync(join(tmpdir(), "clio-coder-install-script-"));
	try {
		const result = spawnSync("sh", [SCRIPT, ...args], {
			env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" },
			input: "",
			encoding: "utf8",
		});
		return {
			code: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			created: existsSync(join(home, ".local")),
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("contracts/install-script", () => {
	it("pins the same Node floor as package.json engines.node", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } };
		const floor = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(pkg.engines?.node ?? "")?.[1];
		ok(floor, "package.json engines.node must be a >=X.Y.Z range");
		match(readFileSync(SCRIPT, "utf8"), new RegExp(`^NODE_MIN="${floor.replaceAll(".", "\\.")}"$`, "mu"));
	});

	it("keeps the body inside main() so a truncated download runs nothing", () => {
		const text = readFileSync(SCRIPT, "utf8");
		match(text, /\nmain "\$@"\n$/u, "main is the last line");
		strictEqual(text.indexOf("\nmain() {"), text.lastIndexOf("\nmain() {"));
	});

	it("rejects version specs that could reach a different package or a shell", () => {
		for (const spec of ["latest; id", "npm:evil@1.0.0", "../evil", ">=0.4.0", "file:/x", "0.4", "Latest", "$(id)"]) {
			const r = run(["--dry-run", "--version", spec]);
			strictEqual(r.code, 1, `spec ${JSON.stringify(spec)} must be refused:\n${r.stderr}`);
			match(r.stderr, /invalid --version/u);
		}
	});

	it("dry run names the plan and writes nothing", () => {
		const r = run(["--dry-run", "--version", "v0.6.0"]);
		strictEqual(r.code, 0, r.stderr);
		match(r.stdout, /package: +@iowarp\/clio-coder@0\.6\.0$/mu);
		match(r.stdout, /would install the newest Node v24\.x/u);
		match(r.stdout, /dry run complete/u);
		ok(!r.created, "a dry run creates nothing under HOME");
	});
});
