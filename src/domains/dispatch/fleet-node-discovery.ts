import { isIP } from "node:net";
import { runCommandVector } from "../../core/safe-exec.js";

export interface TailscaleNodeCandidate {
	id: string;
	name: string;
	magicDns: string | null;
	addresses: string[];
	online: boolean | null;
	os: string | null;
}

/** Tailscale reports peers, never SSH access, installed runtimes or project readiness. */
export async function discoverTailscaleNodes(): Promise<TailscaleNodeCandidate[]> {
	const result = await runCommandVector("tailscale", ["status", "--json"], {
		timeoutMs: 10_000,
		maxOutputBytes: 1_000_000,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			result.exitCode === null || result.exitCode === 127
				? "Tailscale CLI is unavailable. Install/sign in to Tailscale if you want discovery, or add an SSH node with 'fleet nodes add <id> --host <host>'."
				: "Tailscale status failed. Check that its daemon is running and signed in, or add an SSH host directly. Tailscale is optional.",
		);
	}
	let status: { BackendState?: string; Peer?: Record<string, unknown> };
	try {
		status = JSON.parse(result.stdout);
	} catch {
		throw new Error("Tailscale returned invalid status JSON; update its CLI or add an SSH host directly");
	}
	if (status?.BackendState !== "Running")
		throw new Error(
			`Tailscale is ${status?.BackendState ?? "not running"}; sign in/start it for discovery, or add an SSH host directly`,
		);
	if (!status.Peer || typeof status.Peer !== "object" || Array.isArray(status.Peer)) return [];
	return Object.entries(status.Peer)
		.slice(0, 128)
		.flatMap(([id, value]) => {
			if (!value || typeof value !== "object") return [];
			const peer = value as Record<string, unknown>;
			const name = typeof peer.HostName === "string" ? peer.HostName.slice(0, 128) : "unnamed peer";
			const magicDns =
				typeof peer.DNSName === "string" && /^[a-zA-Z0-9.-]+\.?$/.test(peer.DNSName)
					? peer.DNSName.replace(/\.$/, "")
					: null;
			const addresses = Array.isArray(peer.TailscaleIPs)
				? peer.TailscaleIPs.filter(
						(address): address is string => typeof address === "string" && isIP(address) !== 0,
					).slice(0, 4)
				: [];
			return [
				{
					id,
					name,
					magicDns,
					addresses,
					online: typeof peer.Online === "boolean" ? peer.Online : null,
					os: typeof peer.OS === "string" ? peer.OS.slice(0, 32) : null,
				},
			];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
