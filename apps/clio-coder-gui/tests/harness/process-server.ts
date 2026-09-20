import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
export async function processServer(env: NodeJS.ProcessEnv) {
	const child = spawn(
		process.execPath,
		["--import", "tsx", fileURLToPath(new URL("../../server/main.ts", import.meta.url))],
		{
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			env: {
				...env,
				CLIO_CODER_WEB_CLI:
					env.CLIO_CODER_WEB_CLI ?? fileURLToPath(new URL("../fixtures/acp-fixture-child.mjs", import.meta.url)),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	let stdout = "",
		stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const launch = await new Promise<URL>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Server startup timed out: ${stderr}`));
		}, 15000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(new Error(`Server exited before launch: ${stderr}`));
		});
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/);
			if (match) {
				clearTimeout(timer);
				resolve(new URL(match[0]));
			}
		});
	});
	const token = new URLSearchParams(launch.hash.slice(1)).get("token");
	const request = (path: string, method = "GET", body?: unknown) =>
		new Promise<Response>((resolve, reject) => {
			const call = httpRequest(
				new URL(path, launch),
				{
					method,
					headers: {
						Authorization: `Bearer ${token}`,
						...(body === undefined
							? {}
							: {
									"Content-Type": "application/json",
									"Content-Length": String(Buffer.byteLength(JSON.stringify(body))),
									"Idempotency-Key": crypto.randomUUID(),
								}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					response.on("end", () =>
						resolve(
							new Response(Buffer.concat(chunks), {
								status: response.statusCode ?? 500,
								headers: { "Content-Type": String(response.headers["content-type"] ?? "") },
							}),
						),
					);
				},
			);
			call.on("error", reject);
			call.end(body === undefined ? undefined : JSON.stringify(body));
		});
	return {
		child,
		url: launch.href,
		pid: child.pid ?? 0,
		request,
		post: (path: string, body: unknown = {}) => request(path, "POST", body),
		async close(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
			child.kill(signal);
			await exited;
		},
	};
}
