import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FileAuthStorageBackend } from "../../src/domains/providers/auth/backend-file.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";

const SOURCE_CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const FAKE_KEY = "dogfood-contract-key-not-a-real-credential";
const MODEL = "fixture/model";

function inventory(root: string): unknown[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			const stats = statSync(path);
			return {
				path: path.slice(root.length + 1),
				mode: stats.mode & 0o777,
				...(entry.isFile()
					? { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mtime: stats.mtimeMs }
					: {}),
			};
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

function doctor(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["--import", import.meta.resolve("tsx"), SOURCE_CLI, "doctor", ...args],
			{
				cwd: root,
				timeout: 30_000,
				env: {
					...process.env,
					CLIO_CODER_HOME: root,
					CLIO_CODER_CONFIG_DIR: join(root, "config"),
					CLIO_CODER_DATA_DIR: join(root, "data"),
					CLIO_CODER_STATE_DIR: join(root, "state"),
					CLIO_CODER_CACHE_DIR: join(root, "cache"),
					DOGFOOD_DOCTOR_KEY: FAKE_KEY,
				},
			},
			(error, stdout, stderr) => {
				if (!error) resolve({ code: 0, stdout, stderr });
				else if (typeof error.code === "number" && !error.killed) resolve({ code: error.code, stdout, stderr });
				else reject(error);
			},
		);
	});
}

describe("contracts/DOG-001 doctor credential reads", () => {
	let root: string;
	let path: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clio-dogfood-doctor-"));
		path = join(root, "config", "credentials.yaml");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	for (const stored of [false, true]) {
		it(`repeated text/JSON doctor preserves the home with ${stored ? "existing" : "missing"} credentials`, async () => {
			const requests: string[] = [];
			const server = createServer((request, response) => {
				requests.push(`${request.method} ${request.url}`);
				response.setHeader("content-type", "application/json");
				if (request.method === "GET" && request.url === "/health/liveliness") {
					response.end("{}");
				} else if (
					request.method === "GET" &&
					request.url === "/v1/model/info" &&
					request.headers.authorization === `Bearer ${FAKE_KEY}`
				) {
					response.end(JSON.stringify({ data: [{ model_name: MODEL, model_info: { mode: "chat" } }] }));
				} else {
					response.writeHead(403);
					response.end("{}");
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				for (const role of ["config", "data", "state", "cache"]) {
					mkdirSync(join(root, role), { mode: 0o700 });
				}
				writeFileSync(
					join(root, "config", "settings.yaml"),
					[
						"version: 2",
						"targets:",
						"  - id: fixture",
						"    runtime: litellm",
						`    url: http://127.0.0.1:${(server.address() as AddressInfo).port}`,
						"    auth:",
						stored ? "      apiKeyRef: fixture" : "      apiKeyEnvVar: DOGFOOD_DOCTOR_KEY",
						`    defaultModel: ${MODEL}`,
						"chat:",
						"  target: fixture",
						`  model: ${MODEL}`,
						"  prewarm: false",
						"",
					].join("\n"),
					{ mode: 0o600 },
				);
				if (stored) {
					const storage = openAuthStorage(path);
					storage.setApiKey("fixture", FAKE_KEY);
					storage.setApiKey("other-provider", "unrelated-synthetic-key");
				}
				const before = inventory(root);
				for (const args of [[], ["--json"], [], ["--json"]]) {
					const result = await doctor(root, args);
					strictEqual(result.code, 1, "uninitialized state metadata remains a reported problem");
					strictEqual(result.stderr, "");
					deepStrictEqual(inventory(root), before, "doctor without --fix must leave the home unchanged");
					if (args.length > 0) {
						const report = JSON.parse(result.stdout) as {
							findings: Array<{ name: string; ok: boolean; detail: string }>;
						};
						const credential = report.findings.find((finding) => finding.name === "credentials");
						strictEqual(credential?.ok, stored);
						match(credential?.detail ?? "", stored ? /^600$/ : /^missing /);
						const model = report.findings.find((finding) => finding.name === "model fixture");
						strictEqual(model?.ok, true);
						match(model?.detail ?? "", /advertised by .* now$/);
					} else {
						match(result.stdout, stored ? /OK\s+credentials\s+600/ : /!!\s+credentials\s+missing /);
						match(result.stdout, /OK\s+model fixture\s+.*advertised by .* now/);
					}
				}
				strictEqual(requests.filter((request) => request === "GET /v1/model/info").length, 4);
				ok(
					requests.every((request) => request.startsWith("GET ")),
					"diagnosis never starts inference",
				);
			} finally {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		});
	}

	it("opening and reloading missing credential storage creates no directories or files", () => {
		const before = inventory(root);
		const storage = openAuthStorage(path);
		storage.reload();
		strictEqual(storage.damageReason(), null);
		deepStrictEqual(storage.listStored(), []);
		deepStrictEqual(inventory(root), before);
	});

	it("first login writes privately and merges credentials from another storage instance", () => {
		const first = openAuthStorage(path);
		const stale = openAuthStorage(path);
		first.setApiKey("first-provider", FAKE_KEY);
		strictEqual(first.damageReason(), null);
		strictEqual(statSync(path).mode & 0o777, 0o600);
		stale.setApiKey("second-provider", "second-synthetic-key");
		const reopened = openAuthStorage(path);
		deepStrictEqual(reopened.get("first-provider"), first.get("first-provider"));
		deepStrictEqual(reopened.get("second-provider"), stale.get("second-provider"));
		deepStrictEqual(readdirSync(join(root, "config")), ["credentials.yaml"]);
	});

	it("reads the committed snapshot while a writer holds the lock without disturbing the writer", async () => {
		const storage = openAuthStorage(path);
		storage.setApiKey("fixture", FAKE_KEY);
		const before = readFileSync(path, "utf8");
		await new FileAuthStorageBackend(path).withLockAsync(async (current) => {
			strictEqual(current, before);
			const lockBefore = readFileSync(`${path}.lock`, "utf8");
			const reader = openAuthStorage(path);
			strictEqual(reader.damageReason(), null);
			deepStrictEqual(reader.get("fixture"), storage.get("fixture"));
			strictEqual(readFileSync(path, "utf8"), before);
			strictEqual(readFileSync(`${path}.lock`, "utf8"), lockBefore);
			return { result: undefined, next: before.replace(FAKE_KEY, "replacement-synthetic-key") };
		});
		const credential = openAuthStorage(path).get("fixture");
		ok(credential?.type === "api_key");
		strictEqual(credential.key, "replacement-synthetic-key");
		deepStrictEqual(readdirSync(join(root, "config")), ["credentials.yaml"]);
	});

	it("serializes asynchronous writes to an initially missing file without losing an update", async () => {
		const backends = Array.from({ length: 4 }, () => new FileAuthStorageBackend(path));
		await Promise.all(
			backends.map((backend, index) =>
				backend.withLockAsync(async (current) => {
					const entries = JSON.parse(current || "[]") as number[];
					await delay(10);
					return { result: undefined, next: JSON.stringify([...entries, index]) };
				}),
			),
		);
		deepStrictEqual((JSON.parse(readFileSync(path, "utf8")) as number[]).sort(), [0, 1, 2, 3]);
		strictEqual(statSync(path).mode & 0o777, 0o600);
		deepStrictEqual(readdirSync(join(root, "config")), ["credentials.yaml"]);
	});

	it("failed or cancelled first writes never leave an empty credentials file", async () => {
		const backend = new FileAuthStorageBackend(path);
		throws(
			() =>
				backend.withLock(() => {
					throw new Error("synthetic write failure");
				}),
			/synthetic write failure/,
		);
		strictEqual(existsSync(path), false);
		const controller = new AbortController();
		await rejects(
			backend.withLockAsync(
				async () => {
					controller.abort(new Error("synthetic cancellation"));
					return { result: undefined, next: "must not be written" };
				},
				{ signal: controller.signal },
			),
			/synthetic cancellation/,
		);
		strictEqual(existsSync(path), false);
		deepStrictEqual(readdirSync(join(root, "config")), []);
	});
});
