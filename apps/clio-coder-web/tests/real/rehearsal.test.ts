import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const app = fileURLToPath(new URL("../../", import.meta.url));
const source = join(app, "dist/rehearsal");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

async function start(entry: string, scratch: string, pinned: boolean, diagnostics = true) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: diagnostics ? "test" : "production",
		NODE_OPTIONS: "",
		NODE_PATH: "",
		PATH: "",
	};
	delete env.CLIO_CODER_PACKAGE_ROOT;
	if (pinned) env.CLIO_CODER_PACKAGE_ROOT = root;
	for (const role of ["config", "data", "state", "cache"]) {
		const path = join(scratch, role);
		await mkdir(path, { recursive: true });
		env[`CLIO_CODER_${role.toUpperCase()}_DIR`] = path;
	}
	const flags =
		process.env.REHEARSAL_PERMISSION === "1"
			? [
					"--permission",
					"--allow-child-process",
					"--allow-worker",
					`--allow-fs-read=${root}`,
					`--allow-fs-read=${scratch}`,
					"--allow-fs-read=/proc",
					`--allow-fs-write=${scratch}`,
				]
			: [];
	const child = spawn(process.execPath, [...flags, entry], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "",
		stderr = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const close = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
		await exited;
		clearTimeout(timeout);
	};
	try {
		const deadline = performance.now() + 10000;
		let match: RegExpMatchArray | null = null;
		while (performance.now() < deadline) {
			match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=([\w-]+)/);
			if (match) break;
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Rehearsal server failed: ${stderr}`);
			await delay(50);
		}
		assert.ok(match, `Rehearsal startup deadline: ${stderr}`);
		const origin = new URL(match[0]).origin,
			token = match[1];
		return {
			close,
			async request(path: string, body?: unknown) {
				return fetch(`${origin}${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"Idempotency-Key": crypto.randomUUID(),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(15000),
				});
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}

test("compiled three-entry server exposes the package-root hazard then runs isolated from tsx with both emitted workers", {
	timeout: 60000,
}, async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-web-rehearsal-"));
	const report: Record<string, unknown> = {
		scratch,
		node: process.version,
		permission: process.env.REHEARSAL_PERMISSION === "1",
	};
	try {
		const hazard = await start(join(source, "web/server.js"), scratch, false);
		try {
			const meta = await (await hazard.request("/api/meta")).json();
			assert.equal(meta.clio, "0.0.0");
			const runtime = await (await hazard.request("/api/_diagnostics/runtime")).json();
			assert.equal(runtime.server.packageRoot, app.replace(/\/$/, ""));
			assert.equal(runtime.reads.packageRoot, runtime.server.packageRoot);
			assert.equal(runtime.ops.packageRoot, runtime.server.packageRoot);
			report.unpinned = { clio: meta.clio, runtime };
		} finally {
			await hazard.close();
		}
		const pkg = join(scratch, "package");
		await cp(source, join(pkg, "dist"), { recursive: true });
		await writeFile(
			join(pkg, "package.json"),
			JSON.stringify({ name: "rehearsal-only", type: "module", version: "0.0.0" }),
		);
		// Only declared runtime packages are linked. No checkout node_modules parent, tsx, or source loader.
		for (const name of Object.keys(manifest.dependencies)) {
			const destination = join(pkg, "node_modules", name);
			await mkdir(dirname(destination), { recursive: true });
			await symlink(await realpath(join(root, "node_modules", name)), destination);
		}
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				'try { import.meta.resolve("tsx"); process.exit(1); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }',
			],
			{
				cwd: pkg,
				env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
				encoding: "utf8",
			},
		);
		assert.equal(probe.status, 0, probe.stderr);
		const entry = join(pkg, "dist/web/server.js");
		const imported = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const entry = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof entry.main !== "function") throw Error("missing main");`,
			],
			{
				cwd: scratch,
				env: { ...process.env, CLIO_CODER_PACKAGE_ROOT: root, NODE_OPTIONS: "", NODE_PATH: "" },
				encoding: "utf8",
				timeout: 10000,
			},
		);
		assert.equal(imported.status, 0, imported.stderr);
		assert.equal(imported.stdout, "", "Importing the entry must not start another HTTP process.");
		const server = await start(entry, scratch, true);
		try {
			const meta = await (await server.request("/api/meta")).json();
			assert.equal(meta.clio, manifest.version);
			const runtime = await (await server.request("/api/_diagnostics/runtime")).json();
			for (const [kind, file] of [
				["server", "server.js"],
				["reads", "reads-worker.js"],
				["ops", "ops-worker.js"],
			] as const) {
				assert.equal(runtime[kind].packageRoot, root.replace(/\/$/, ""));
				assert.equal(runtime[kind].entry, pathToFileURL(join(pkg, "dist/web", file)).href);
				assert.equal(
					runtime[kind].execArgv.some((arg: string) => arg.includes("tsx") || arg === "--import"),
					false,
				);
			}
			assert.ok(runtime.reads.threadId > 0 && runtime.ops.threadId > 0 && runtime.reads.threadId !== runtime.ops.threadId);
			const tools = await server.request("/api/toolchain/tools");
			assert.equal(tools.status, 200);
			assert.equal((await tools.json()).length, 3);
			const remove = await server.request("/api/toolchain/tools/herdr/remove", {});
			assert.equal(remove.status, 202);
			const { operationId } = await remove.json();
			let operation: { status: string } | undefined;
			for (let i = 0; i < 100; i++) {
				operation = await (await server.request(`/api/operations/${operationId}`)).json();
				if (operation && !["queued", "running"].includes(operation.status)) break;
				await delay(50);
			}
			assert.ok(operation);
			assert.equal(operation.status, "succeeded", JSON.stringify(operation));
			assert.equal((await server.request("/")).status, 200);
			report.pinned = {
				clio: meta.clio,
				runtime,
				removalStatus: operation.status,
				tsxResolvable: false,
				importStartsServer: false,
			};
		} finally {
			await server.close();
		}
		const production = await start(entry, scratch, true, false);
		try {
			assert.equal((await production.request("/api/_diagnostics/runtime")).status, 404);
		} finally {
			await production.close();
		}
		report.verdict = "pass";
	} catch (error) {
		report.verdict = "fail";
		report.error = String(error);
		throw error;
	} finally {
		await writeFile(join(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		console.log(`Rehearsal report: ${join(scratch, "report.json")}`);
	}
});

async function emittedFiles(directory: string): Promise<{ path: string; bytes: number }[]> {
	const { readdir, stat } = await import("node:fs/promises");
	const files: { path: string; bytes: number }[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await emittedFiles(path)));
		else if (!entry.name.endsWith(".map")) files.push({ path, bytes: (await stat(path)).size });
	}
	return files;
}

test("record the three entries, shared chunks and a conservative combined tarball against release budgets", {
	timeout: 60000,
}, async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-web-package-size-"));
	const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
		cwd: root,
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(packed.status, 0, packed.stderr);
	const baseline = JSON.parse(packed.stdout)[0];
	const extract = spawnSync("tar", ["-xf", join(scratch, baseline.filename), "-C", scratch], { encoding: "utf8" });
	assert.equal(extract.status, 0, extract.stderr);
	await cp(source, join(scratch, "package/dist"), { recursive: true, filter: (path) => !path.endsWith(".map") });
	const combinedDir = join(scratch, "combined");
	await mkdir(combinedDir);
	// Use npm's own file selection, ordering and archive metadata for a comparable projection.
	const repacked = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", combinedDir], {
		cwd: join(scratch, "package"),
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(repacked.status, 0, repacked.stderr);
	const combined = JSON.parse(repacked.stdout)[0];
	const files = await emittedFiles(source);
	const sizes = files
		.map((file) => ({ path: file.path.slice(source.length + 1), bytes: file.bytes }))
		.sort((a, b) => a.path.localeCompare(b.path));
	const entries = sizes.filter((file) => /^web\/(server|reads-worker|ops-worker)\.js$/.test(file.path));
	assert.equal(entries.length, 3);
	const chunks = sizes.filter((file) => !file.path.startsWith("web/"));
	const client = sizes.filter((file) => file.path.startsWith("web/client/"));
	for (const file of sizes)
		assert.ok(
			combined.files.some((entry: { path: string }) => entry.path === `dist/${file.path}`),
			`Repacked web asset missing: ${file.path}`,
		);
	const packedBytes = combined.size,
		unpackedBytes = combined.unpackedSize;
	const report = {
		node: process.version,
		scratch,
		baseline: { packedBytes: baseline.size, unpackedBytes: baseline.unpackedSize, files: baseline.files.length },
		entries,
		sharedChunks: chunks,
		client: { files: client.length, bytes: client.reduce((total, file) => total + file.bytes, 0) },
		webUnpackedBytes: sizes.reduce((total, file) => total + file.bytes, 0),
		projection: {
			packedBytes,
			unpackedBytes,
			packedDelta: packedBytes - baseline.size,
			packedBudget: 10000000,
			unpackedBudget: 50000000,
			fitsPacked: packedBytes <= 10000000,
			fitsUnpacked: unpackedBytes <= 50000000,
		},
		qualification:
			"Combines the current root tarball with the independently split three-entry web build. R1 must measure a single integrated build, carry new third-party notices, and pass the actual installed-package and release gates. Source maps excluded as in the root files policy.",
	};
	await writeFile(join(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Package size report: ${join(scratch, "report.json")}`);
});
