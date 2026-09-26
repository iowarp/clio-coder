import { request } from "node:http";
import { setTimeout } from "node:timers/promises";

/** What a ready background app reports about itself; `clio` is the version its process loaded. */
export interface LocalServerMeta {
	clio: string;
}

/** Readiness checks are the sole app-owned socket client: fixed loopback, fixed path, no redirects. */
export async function localServerReady(port: number, token: string) {
	return (await localServerMeta(port, token)) !== null;
}

/** The background app's own report, or null when nothing ready answers as this app with this token. */
export async function localServerMeta(port: number, token: string) {
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[\w-]{32,256}$/.test(token))
		throw new Error("Invalid local server identity.");
	return new Promise<LocalServerMeta | null>((resolve) => {
		const req = request(
			{ hostname: "127.0.0.1", port, path: "/api/meta", headers: { Authorization: `Bearer ${token}` } },
			(response) => {
				let body = "";
				response.on("data", (chunk: Buffer) => {
					body += chunk.toString("utf8");
					if (body.length > 8192) req.destroy();
				});
				response.on("error", () => resolve(null));
				response.on("end", () => {
					try {
						const value = JSON.parse(body);
						resolve(
							response.statusCode === 200 && value.apiVersion === 1 && value.pwa === true
								? { clio: typeof value.clio === "string" ? value.clio.slice(0, 64) : "unknown" }
								: null,
						);
					} catch {
						resolve(null);
					}
				});
			},
		);
		req.on("error", () => resolve(null));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(null);
		});
		req.end();
	});
}
export async function waitForLocalServer(port: number, token: string): Promise<LocalServerMeta> {
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		const meta = await localServerMeta(port, token);
		if (meta) return meta;
		await setTimeout(200);
	}
	throw new Error(
		`Clio did not become ready on port ${port}. Check background status; another application may be using that port.`,
	);
}
