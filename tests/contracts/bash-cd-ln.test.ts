import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";

/**
 * A bash write target is resolved from every directory the shell can be in
 * when it opens it, not only from the call's cwd, and a link the command makes
 * is judged by where it points. The workspace root sits one level inside its
 * own temp directory. `data/linkdir` and `data/sub/sublink` point outside, at
 * `<base>/elsewhere/deep`; `rootlink` does too, from the root.
 */
describe("bash write targets after cd, and links made in the same command", () => {
	let originalCwd: string;
	let base: string;
	let root: string;
	let deep: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-bash-cd-ln-")));
		root = join(base, "root");
		deep = join(base, "elsewhere", "deep");
		mkdirSync(join(root, "data", "sub"), { recursive: true });
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(base, "elsewhere", "file.txt"), "outside\n");
		symlinkSync("../../elsewhere/deep", join(root, "data", "linkdir"));
		symlinkSync("../../../elsewhere/deep", join(root, "data", "sub", "sublink"));
		symlinkSync("../elsewhere/deep", join(root, "rootlink"));
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(base, { recursive: true, force: true });
	});

	function bashClass(command: string): { actionClass: string; reasons: readonly string[] } {
		return classify({ tool: ToolNames.Bash, args: { command } });
	}

	function shell(command: string): void {
		execFileSync("bash", ["-c", command], { cwd: root, stdio: "ignore" });
	}

	function assertEscalated(command: string, reasons: string[]): void {
		deepStrictEqual(bashClass(command), { actionClass: "system_modify", reasons }, command);
	}

	function assertExecute(command: string): void {
		deepStrictEqual(bashClass(command), { actionClass: "execute", reasons: [] }, command);
	}

	it("resolves a redirect after `cd` from the directory the cd lands in, across separators", () => {
		const landing = `write-path-outside-cwd: ${join(deep, "out.txt")}`;
		for (const command of [
			"cd data && echo x > linkdir/out.txt",
			"cd data; echo x > linkdir/out.txt",
			"cd data\necho x > linkdir/out.txt",
		]) {
			assertEscalated(command, [landing]);
		}
		shell("cd data && echo x > linkdir/out.txt");
		ok(existsSync(join(deep, "out.txt")), "the shell wrote outside, where admission said");
	});

	it("follows two chained cds, a subshell, a brace group, and an if body", () => {
		assertEscalated("cd data && cd sub && echo x > sublink/two.txt", [
			`write-path-outside-cwd: ${join(deep, "two.txt")}`,
		]);
		assertEscalated("(cd data && echo x > linkdir/sub.txt)", [`write-path-outside-cwd: ${join(deep, "sub.txt")}`]);
		assertEscalated("{ cd data; echo x > linkdir/brace.txt; }", [`write-path-outside-cwd: ${join(deep, "brace.txt")}`]);
		assertEscalated("if true; then cd data; fi; echo x > linkdir/if.txt", [
			`write-path-outside-cwd: ${join(deep, "if.txt")}`,
		]);
		// A cd hidden in a subshell or an if body is still a cd out of the workspace.
		assertEscalated("(cd /tmp && echo x > out.txt)", ["bash-cd-outside-workspace: /tmp"]);
		shell("(cd data && echo x > linkdir/sub.txt)");
		ok(existsSync(join(deep, "sub.txt")));
	});

	it("keeps the directory before a cd wherever the command can run on without it", () => {
		const fromRoot = `write-path-outside-cwd: ${join(deep, "o.txt")}`;
		// The cd may fail, or its subshell ends, and the write opens from the root.
		for (const command of [
			"cd data; echo x > rootlink/o.txt",
			"cd data || echo no; echo x > rootlink/o.txt",
			"(cd data && true) && echo x > rootlink/o.txt",
			"true | cd data && echo x > rootlink/o.txt",
			"! cd data && echo x > rootlink/o.txt",
			"cd data && true || echo x > rootlink/o.txt",
		]) {
			assertEscalated(command, [fromRoot]);
		}
		// What follows `&&` or `|| exit` runs only where the cd landed.
		assertExecute("cd data && echo x > rootlink/o.txt");
		assertExecute("cd data || exit 1; echo x > rootlink/o.txt");
	});

	it("cannot place a relative write after a cd the shell expands at run time, or one a loop repeats", () => {
		for (const command of ['cd "$DIR" && echo x > out.txt', "cd $(mktemp -d) && echo x > out.txt"]) {
			assertEscalated(command, ["write-path-unknown-base: out.txt"]);
		}
		assertEscalated("for i in 1 2; do cd data; done; echo x > out.txt", ["write-path-unknown-base: out.txt"]);
		assertEscalated("f() { cd data; }; f; echo x > out.txt", ["write-path-unknown-base: out.txt"]);
		assertExecute(`cd "$DIR" && echo x > ${join(root, "data", "abs.txt")}`);
	});

	it("escalates a symbolic link whose target leaves the workspace, and keeps an inside one", () => {
		const outside = `bash-symlink-outside-workspace: ${join(base, "elsewhere")}`;
		for (const command of [
			"ln -s ../elsewhere l && echo x > l/ln.txt",
			"ln -sfn ../elsewhere l",
			"ln --symbolic ../elsewhere l",
			"cd data && ln -s ../../elsewhere l",
		]) {
			assertEscalated(command, [outside]);
		}
		assertEscalated('ln -s "$T" l', ["bash-symlink-outside-workspace: $T"]);
		assertEscalated("cp -s /etc/passwd p", ["bash-symlink-outside-workspace: /etc/passwd"]);
		// -t names the link directory; the target resolves from there.
		ok(bashClass("ln -s -t data ../../elsewhere").reasons.includes(outside));
		assertExecute("ln -s ./a ./b");
		assertExecute("ln -s ../sub data/up");
		shell("ln -s ../elsewhere l && echo x > l/ln.txt");
		ok(existsSync(join(base, "elsewhere", "ln.txt")), "the write went through the new link");
	});

	it("escalates a hard link to a file outside the workspace", () => {
		const outside = `bash-hardlink-outside-workspace: ${join(base, "elsewhere", "file.txt")}`;
		assertEscalated("ln ../elsewhere/file.txt h && echo y >> h", [outside]);
		assertEscalated("cp -l ../elsewhere/file.txt h", [outside]);
		assertExecute("ln data/sub/../../src h");
	});

	it("keeps common in-workspace commands plain execute", () => {
		for (const command of [
			"cd src && ls",
			"cd src && echo x > out.txt",
			"ln -s ./a ./b",
			"cd src && npm install && cd .. && npm test",
			"cd src && npm run build > ../build.log 2>&1",
			"(cd src && make) && echo done > status.txt",
			"cd src && for f in *.ts; do echo $f; done > ../list.txt",
			"cd src && ls | head > ../list.txt",
			"pushd src && echo x > a.txt && popd && echo y > b.txt",
			"mkdir -p out && cd out && echo x > result.txt",
		]) {
			assertExecute(command);
		}
		strictEqual(existsSync(join(deep, "out.txt")), false);
	});
});
