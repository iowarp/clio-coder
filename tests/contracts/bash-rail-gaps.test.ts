// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell parameter expansion is the input under test.
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";

/**
 * Bash writes the static rail missed after SEC3: targets the shell expands,
 * here-document bodies read as commands, and links made without a plain
 * `ln -s`. Each command is also run through real `bash -c` to show the write
 * lands outside. The workspace root sits one level inside its temp directory;
 * `data/linkdir` and `rootlink` point outside, at `<base>/elsewhere/deep`.
 */
describe("bash rail gaps: dynamic targets, here-documents, and indirect links", () => {
	let originalCwd: string;
	let base: string;
	let root: string;
	let deep: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-bash-rail-gaps-")));
		root = join(base, "root");
		deep = join(base, "elsewhere", "deep");
		mkdirSync(join(root, "data"), { recursive: true });
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(base, "elsewhere", "file.txt"), "outside\n");
		symlinkSync("../../elsewhere/deep", join(root, "data", "linkdir"));
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

	function shell(command: string, env: NodeJS.ProcessEnv = process.env): void {
		execFileSync("bash", ["-c", command], { cwd: root, stdio: "ignore", env });
	}

	function assertEscalated(command: string, reasons: string[]): void {
		deepStrictEqual(bashClass(command), { actionClass: "system_modify", reasons }, command);
	}

	function assertExecute(command: string): void {
		deepStrictEqual(bashClass(command), { actionClass: "execute", reasons: [] }, command);
	}

	it("cannot place a write target the shell expands, a variable or a brace expansion", () => {
		for (const target of ["$HOME/o", "${HOME}/o", "{rootlink/o,y}", "rootlink/{a,b}"]) {
			assertEscalated(`echo x > ${target}`, [`write-path-unknown-base: ${target}`]);
		}
		assertEscalated("tee {rootlink/t,y} </dev/null", ["write-path-unknown-base: {rootlink/t,y}"]);
		// A brace expansion in a link operand makes the link's target unknown too.
		assertEscalated("ln -s {../elsewhere,l} && echo x > l/o", ["bash-symlink-outside-workspace: {../elsewhere,l}"]);
		// A lone `{}` is literal to the shell, and `/dev/*` is not a workspace file.
		assertExecute("echo x > out-{}.txt");
		assertExecute("echo x > /dev/fd/$fd");
		shell("echo x > $HOME/home.txt", { ...process.env, HOME: deep });
		shell("ln -s {../elsewhere,l} && echo x > l/brace.txt");
		ok(existsSync(join(deep, "home.txt")) && existsSync(join(base, "elsewhere", "brace.txt")));
	});

	it("does not read here-document body lines as commands that hide a real cd", () => {
		const landing = `write-path-outside-cwd: ${join(deep, "o")}`;
		// A body `(` and `)` around a real cd made the walk restore the root base.
		const parens = "cat <<EOF\n(\nEOF\ncd data\ncat <<EOF\n)\nEOF\necho x > linkdir/o\n";
		// A lone quote in a body swallowed every later command.
		const quote = "cat <<EOF\nit's\nEOF\ncd data\necho x > linkdir/o\n";
		const dashed = "cat <<-EOF\n\t(\n\tEOF\ncd data\ncat <<- 'EOF'\n)\nEOF\necho x > linkdir/o";
		for (const command of [parens, quote, dashed]) assertEscalated(command, [landing]);
		// A here-document inside a script or a substitution is not removed, so
		// every cd after it is unmodeled.
		for (const command of [
			`sh -c "${quote}"`,
			"x=$(cat <<EOF\n(\nEOF\n)\ncd data\ny=$(cat <<EOF\n)\nEOF\n)\necho x > linkdir/o",
		]) {
			assertEscalated(command, ["write-path-unknown-base: linkdir/o"]);
		}
		assertExecute("cd data && cat > notes.txt <<'EOF'\nhello (world) it's\ncd /\nEOF\n");
		shell(parens);
		ok(existsSync(join(deep, "o")), "bash wrote through data/linkdir");
	});

	it("escalates links made by link, mv, a link-keeping cp, or ln behind a wrapper", () => {
		const hard = `bash-hardlink-outside-workspace: ${join(base, "elsewhere", "file.txt")}`;
		const symbolic = `bash-symlink-outside-workspace: ${deep}`;
		const up = `bash-symlink-outside-workspace: ${join(base, "elsewhere")}`;
		assertEscalated("link ../elsewhere/file.txt h && echo y >> h", [hard]);
		assertEscalated("nice -n 5 link ../elsewhere/file.txt h", [hard]);
		for (const command of [
			"mv rootlink l2 && echo x > l2/o",
			"cp -a rootlink l2",
			"cp -P rootlink l2",
			"cp -d rootlink l2",
			"cp --no-dereference rootlink l2",
			"cp -r rootlink l2",
			"mv root* l2",
			"mv data/* l2/",
		]) {
			assertEscalated(command, [symbolic]);
		}
		for (const wrapper of ["nice", "nohup", "timeout 5", "stdbuf -o0", "ionice -c3", "chrt -i 0", "busybox"]) {
			assertEscalated(`${wrapper} ln -s ../elsewhere l`, [up]);
		}
		// Operands from input are unknown.
		assertEscalated("echo ../elsewhere l | xargs ln -s", ["bash-symlink-outside-workspace: <input>"]);
		assertEscalated("find . -name x -exec ln -s {} l \\;", [
			"bash-symlink-outside-workspace: {}",
			"bash-symlink-outside-workspace: l",
		]);
		for (const command of ["cp -aL rootlink l2", "cp -a data d2", "mv src s2", "cp rootlink/f f2", "timeout 60 ls"]) {
			assertExecute(command);
		}
		shell("mv rootlink l2 && echo x > l2/mv.txt");
		shell("link ../elsewhere/file.txt h && echo y >> h");
		ok(existsSync(join(deep, "mv.txt")));
		strictEqual(readFileSync(join(base, "elsewhere", "file.txt"), "utf8"), "outside\ny\n");
	});

	it("does not pass an inherited CDPATH to the bash child", async () => {
		const saved = process.env.CDPATH;
		process.env.CDPATH = join(base, "elsewhere");
		try {
			const result = await runBashCommand("cd deep 2>/dev/null && pwd; echo cdpath=${CDPATH-unset}", { cwd: root });
			strictEqual(result.stdout, "cdpath=unset\n");
		} finally {
			if (saved === undefined) delete process.env.CDPATH;
			else process.env.CDPATH = saved;
		}
	});
});
