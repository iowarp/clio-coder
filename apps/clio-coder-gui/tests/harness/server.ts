import { spawn } from "node:child_process";
import { request } from "node:http";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export async function serverProcess(t: TestContext, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			fileURLToPath(import.meta.resolve("tsx")),
			"--import",
			fileURLToPath(new URL("./no-network.ts", import.meta.url)),
			fileURLToPath(new URL("../../server/main.ts", import.meta.url)),
			"--fixture",
			...args,
		],
		{ cwd: "/", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const launch = await new Promise<URL>((resolve, reject) => {
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s#]*#token=[\w-]+/);
			if (match) resolve(new URL(match[0]));
		});
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`Server exited before printing URL: ${stderr}`)));
	});
	const token = new URLSearchParams(launch.hash.slice(1)).get("token");
	const headers = { Authorization: `Bearer ${token}` };
	return {
		child,
		exited,
		launch,
		async json(path: string, body?: unknown) {
			return new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
				const req = request(
					new URL(path, launch),
					{
						method: body === undefined ? "GET" : "POST",
						headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
					},
					(response) => {
						let data = "";
						response.on("data", (chunk) => {
							data += String(chunk);
						});
						response.on("end", () => {
							try {
								resolve({ status: response.statusCode ?? 0, value: JSON.parse(data) });
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				req.on("error", reject);
				req.end(body === undefined ? undefined : JSON.stringify(body));
			});
		},
		connect() {
			return new Promise<() => void>((resolve, reject) => {
				const req = request(new URL("/api/events", launch), { headers }, (response) => {
					if (response.statusCode !== 200) {
						req.destroy();
						reject(new Error("SSE connection failed"));
						return;
					}
					response.once("data", () =>
						resolve(() => {
							response.destroy();
							req.destroy();
						}),
					);
				});
				req.on("error", reject);
				req.end();
			});
		},
	};
}
