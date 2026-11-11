import { request } from "node:http";

/** Redeem a single-use launch ticket for a client credential, as a window does before any other request. */
export function exchangeLaunchTicket(origin: URL, ticket: string, label = "Test process"): Promise<string> {
	const body = JSON.stringify({ label, ticket });
	return new Promise((resolve, reject) => {
		const req = request(
			new URL("/api/auth/clients", origin),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(body)),
					"Idempotency-Key": crypto.randomUUID(),
				},
			},
			(response) => {
				let data = "";
				response.on("data", (chunk) => {
					data += String(chunk);
				});
				response.on("end", () => {
					if (response.statusCode !== 200) reject(new Error(`Launch ticket exchange answered ${response.statusCode}`));
					else resolve((JSON.parse(data) as { credential: string }).credential);
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}
