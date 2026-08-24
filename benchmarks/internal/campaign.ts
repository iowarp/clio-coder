#!/usr/bin/env node

/** Immutable provenance snapshot for one ignored benchmark campaign. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { basename, join, resolve } from "node:path";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type Args = {
	out: string;
	target: string;
	model: string;
	thinking: ThinkingLevel;
	inputs: Map<string, string>;
	selections: Map<string, string[]>;
};

function usage(): never {
	process.stderr.write(
		"usage: node --import tsx benchmarks/internal/campaign.ts --out <dir> --target <id> --model <id> --thinking <level> [--input name=path]... [--selection suite=id,id]...\n",
	);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	let out: string | undefined;
	let target: string | undefined;
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;
	const inputs = new Map<string, string>();
	const selections = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (value === undefined) usage();
		if (flag === "--out") out = value;
		else if (flag === "--target") target = value;
		else if (flag === "--model") model = value;
		else if (flag === "--thinking") {
			if (!THINKING_LEVELS.includes(value as ThinkingLevel)) usage();
			thinking = value as ThinkingLevel;
		} else if (flag === "--input") {
			const pair = splitPair(value);
			inputs.set(pair.name, resolve(pair.value));
		} else if (flag === "--selection") {
			const pair = splitPair(value);
			selections.set(
				pair.name,
				pair.value
					.split(",")
					.map((item) => item.trim())
					.filter((item) => item.length > 0),
			);
		} else usage();
		index += 1;
	}
	if (!out || !target || !model || !thinking) usage();
	return { out: resolve(out), target, model, thinking, inputs, selections };
}

function splitPair(value: string): { name: string; value: string } {
	const separator = value.indexOf("=");
	if (separator < 1 || separator === value.length - 1) usage();
	return { name: value.slice(0, separator), value: value.slice(separator + 1) };
}

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function fileIdentity(path: string): Record<string, string | number> {
	const realpath = realpathSync(path);
	const stat = statSync(realpath);
	if (!stat.isFile()) throw new Error(`campaign input is not a file: ${path}`);
	return {
		path: realpath,
		bytes: stat.size,
		sha256: sha256(readFileSync(realpath)),
	};
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function commandVersion(command: string, args: string[]): string | null {
	try {
		return (
			execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
				.trim()
				.split("\n")[0] ?? null
		);
	} catch {
		return null;
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const path = join(args.out, "campaign.json");
	if (existsSync(path)) throw new Error(`campaign manifest already exists: ${path}`);
	const binary = resolve("dist/cli/index.js");
	const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const status = git(["status", "--porcelain=v1"]);
	const inputIdentities = Object.fromEntries(
		[...args.inputs.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, path]) => [name, fileIdentity(path)]),
	);
	const campaign = {
		schemaVersion: 1,
		runId: basename(args.out),
		createdAt: new Date().toISOString(),
		candidate: {
			version: commandVersion(process.execPath, [binary, "--version"]),
			commit: git(["rev-parse", "HEAD"]),
			branch: git(["branch", "--show-current"]),
			dirty: status.length > 0,
			diffSha256: sha256(diff),
			binary: fileIdentity(binary),
		},
		target: { id: args.target, model: args.model, thinking: args.thinking },
		selection: Object.fromEntries([...args.selections.entries()].sort(([left], [right]) => left.localeCompare(right))),
		inputs: inputIdentities,
		environment: {
			host: hostname(),
			platform: platform(),
			release: release(),
			arch: arch(),
			node: process.version,
			python: commandVersion("python3", ["--version"]),
			uv: commandVersion("uv", ["--version"]),
			terminalBench: commandVersion("tb", ["--help"]),
			herdr: commandVersion("herdr", ["--version"]),
			docker: commandVersion("docker", ["--version"]),
		},
		resultPolicy: {
			harnessStatus: ["valid", "invalid", "blocked"],
			taskStatus: ["pass", "fail", "timeout", "not_scored"],
			attemptsAreImmutable: true,
		},
	};
	mkdirSync(args.out, { recursive: true });
	try {
		writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`campaign manifest already exists: ${path}`);
		}
		throw error;
	}
	process.stdout.write(`${path}\n`);
}

main();
