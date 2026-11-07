import { request } from "node:http";

/** Exchange a launch token for a client credential, as a window does before any other request. */
export function exchangeLaunchToken(origin: URL, token: string, label = "Test process"): Promise<string> {
	const body = JSON.stringify({ label });
	return new Promise((resolve, reject) => {
		const req = request(
			new URL("/api/auth/clients", origin),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
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
					if (response.statusCode !== 200) reject(new Error(`Launch token exchange answered ${response.statusCode}`));
					else resolve((JSON.parse(data) as { credential: string }).credential);
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}
