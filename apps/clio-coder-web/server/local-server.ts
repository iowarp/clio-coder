import { request } from "node:http";
import { setTimeout } from "node:timers/promises";

/** Readiness checks are the sole app-owned socket client: fixed loopback, fixed path, no redirects. */
export async function localServerReady(port: number, token: string) {
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[\w-]{32,256}$/.test(token))
		throw new Error("Invalid local server identity.");
	return new Promise<boolean>((resolve) => {
		const req = request(
			{ hostname: "127.0.0.1", port, path: "/api/meta", headers: { Authorization: `Bearer ${token}` } },
			(response) => {
				let body = "";
				response.on("data", (chunk: Buffer) => {
					body += chunk.toString("utf8");
					if (body.length > 8192) req.destroy();
				});
				response.on("error", () => resolve(false));
				response.on("end", () => {
					try {
						const value = JSON.parse(body);
						resolve(response.statusCode === 200 && value.apiVersion === 1 && value.pwa === true);
					} catch {
						resolve(false);
					}
				});
			},
		);
		req.on("error", () => resolve(false));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}
export async function waitForLocalServer(port: number, token: string) {
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		if (await localServerReady(port, token)) return;
		await setTimeout(200);
	}
	throw new Error(
		`Clio did not become ready on port ${port}. Check background status; another application may be using that port.`,
	);
}
