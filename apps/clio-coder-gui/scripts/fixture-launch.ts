// The launcher exchange the browser scripts need against a fixture listener. The server's ticket helper refuses the
// fixture's short "test-token" (identity() wants 32+ characters, a product safety check), so this proves
// the token over HTTP directly, as tests/harness/app.ts does in process.

import { launcherProof } from "../server/launch-proof.js";

/** What a launch link carries after `#`: `ticket=<single-use ticket>`, as clio-coder gui prints it. */
export async function fixtureLaunch(origin: string): Promise<string> {
	const port = Number(new URL(origin).port);
	const post = async (path: string, body: unknown, bearer?: string) => {
		const response = await fetch(`${origin}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": crypto.randomUUID(),
				...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
			},
			body: JSON.stringify(body),
		});
		if (response.status !== 200) throw new Error(`POST ${path} answered ${response.status}: ${await response.text()}`);
		return (await response.json()) as Record<string, unknown>;
	};
	const field = (answer: Record<string, unknown>, path: string, name: string) => {
		const value = answer[name];
		if (typeof value !== "string" || value.length === 0) throw new Error(`POST ${path} returned no ${name}.`);
		return value;
	};
	const challenge = field(await post("/api/auth/challenge", {}), "/api/auth/challenge", "challenge");
	const credential = field(
		await post("/api/auth/clients", {
			label: "Launcher",
			challenge,
			proof: launcherProof("test-token", challenge, port),
		}),
		"/api/auth/clients",
		"credential",
	);
	const ticket = field(await post("/api/auth/launch-ticket", {}, credential), "/api/auth/launch-ticket", "ticket");
	return `ticket=${ticket}`;
}
