import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { protectedArtifactMutationBlockReason } from "../../src/domains/safety/protected-artifacts.js";

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
		// The reason names where the cd lands, which on macOS is /private/tmp.
		assertEscalated("(cd /tmp && echo x > out.txt)", [`bash-cd-outside-workspace: ${realpathSync("/tmp")}`]);
		shell("(cd data && echo x > linkdir/sub.txt)");
		ok(existsSync(join(deep, "sub.txt")));
	});

	it("keeps the call's cwd as a base after every cd, however the cd is joined", () => {
		const fromRoot = `write-path-outside-cwd: ${join(deep, "o.txt")}`;
		// The cd may fail, run in a pipeline or a closed subshell, or be text the
		// scanner reads as a cd; the write may open from the root in each case.
		for (const command of [
			"cd data; echo x > rootlink/o.txt",
			"cd data || echo no; echo x > rootlink/o.txt",
			"(cd data && true) && echo x > rootlink/o.txt",
			"true | cd data && echo x > rootlink/o.txt",
			"! cd data && echo x > rootlink/o.txt",
			"cd data && true || echo x > rootlink/o.txt",
			"cd data && echo x > rootlink/o.txt",
			"cd data || exit 1; echo x > rootlink/o.txt",
		]) {
			assertEscalated(command, [fromRoot]);
		}
	});

	it("classifies no command of the SEC3 review weaker than the parent did", () => {
		const fromRoot = [`write-path-outside-cwd: ${join(deep, "o")}`];
		// The base-dropping these defeated is gone: each fakes a cd the shell
		// never keeps (`return` at top level, `&`, a backtick script, a heredoc
		// line, `pushd +N`, `pushd -n`), and the write opens from the root.
		for (const command of [
			"cd nodir || return; echo x > rootlink/o",
			"cd nodir || exit & echo x > rootlink/o",
			"x=` cd nodir || exit `; echo x > rootlink/o",
			"cat >/dev/null <<'EOF'\ncd nodir || exit\nEOF\necho x > rootlink/o",
			"x=` cd data ` && echo x > rootlink/o",
			"pushd data && pushd +1 && echo x > rootlink/o",
			"pushd -n data && echo x > rootlink/o",
		]) {
			assertEscalated(command, fromRoot);
		}
		// `$(...)` stays inside the word it sits in, so the path after it is still
		// resolved and still leaves the workspace.
		for (const command of ["echo x > $(echo)/../../etc/x", "echo x >> x$(true)/../../outside/o"]) {
			strictEqual(bashClass(command).actionClass, "system_modify", command);
		}
		const artifacts = [{ path: join(root, "src", "index.ts"), protectedAt: "t", reason: "r", source: "user" as const }];
		const block = protectedArtifactMutationBlockReason({ artifacts }, ToolNames.Bash, {
			command: "rm -rf $(echo)/../..",
		});
		ok(block !== null, "rm -rf $(echo)/../.. is rm -rf / and still hits the protected artifact block");
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
		]) {
			assertEscalated(command, [outside]);
		}
		// After a cd the link may be made in data or, if the cd failed, in the root.
		ok(bashClass("cd data && ln -s ../../elsewhere l").reasons.includes(outside));
		assertEscalated('ln -s "$T" l', ["bash-symlink-outside-workspace: $T"]);
		assertEscalated("cp -s /etc/passwd p", [`bash-symlink-outside-workspace: ${realpathSync("/etc/passwd")}`]);
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
			"(cd src && make) && echo done > status.txt",
			"cd src && for f in *.ts; do echo $f; done > list.txt",
			"pushd src && echo x > a.txt && popd && echo y > b.txt",
			"mkdir -p out && cd out && echo x > result.txt",
			"diff <(ls src) <(ls .)",
		]) {
			assertExecute(command);
		}
		strictEqual(existsSync(join(deep, "out.txt")), false);
	});

	it("escalates, as the parent did, a `..` that leaves the workspace from the call's cwd", () => {
		// If `cd src` failed, `cd ..` and `../build.log` would resolve from the
		// root, so both stay escalated: the price of never dropping a base.
		strictEqual(bashClass("cd src && npm install && cd .. && npm test").actionClass, "system_modify");
		strictEqual(bashClass("cd src && npm run build > ../build.log 2>&1").actionClass, "system_modify");
	});
});
