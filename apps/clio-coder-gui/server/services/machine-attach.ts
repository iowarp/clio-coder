import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import type { MachineAttachment } from "../../contracts/machines.js";
import type { MachineAttachmentsApi, MachineRoute } from "../http/routes-machines.js";
import { type RemoteServerMeta, remoteServerMeta } from "../local-server.js";
import { startSshCommand, startSshForward, stopClioCommand } from "../process-policy.js";
import {
	type BuildIdentity,
	parseReadyLine,
	REMOTE_GUI_IDLE_MS,
	reconnectDelayMs,
	remoteGuiCommand,
	versionGate,
} from "../ssh-model.js";
import type { MachineEndpoint } from "../worker/protocol.js";
import type { EventHub } from "./event-hub.js";
import { AppProblem } from "./problem.js";

export interface MachineAttachDeps {
	/** The registry's SSH destinations, read each time so a node added meanwhile can be opened. */
	endpoints(): Promise<MachineEndpoint[]>;
	/** This server's own version and build, which the node's must match. */
	local(): BuildIdentity;
	hub: EventHub;
	env?: NodeJS.ProcessEnv;
	idleMs?: number;
	readyTimeoutMs?: number;
	metaTimeoutMs?: number;
}

/** Both channels are owned children started by process-policy, the one module that may spawn. */
type ChildProcess = ReturnType<typeof startSshCommand>["child"] | ReturnType<typeof startSshForward>["child"];
type Owned = { child: ChildProcess; birthToken: string | null };
type Live = {
	endpoint: MachineEndpoint;
	token: string;
	command: Owned | null;
	forward: Owned | null;
	localPort: number | null;
};
type Entry = {
	attachment: MachineAttachment;
	live: Live | null;
	timer: ReturnType<typeof setTimeout> | null;
	/** Consecutive failed connections since the operator last opened the machine. */
	failures: number;
	/** Bumped on every start, so a late exit or timeout from an earlier run changes nothing. */
	generation: number;
};

const READY_OUTPUT_LIMIT = 64 * 1024;

/** A free loopback port for the forward's local end; the only listener this app opens besides its own. */
function freeLoopbackPort(): Promise<number> {
	const probe = createAdaptorServer({ fetch: () => new Response(null, { status: 404 }) });
	return new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

/** The remote port from the command channel's ready line; rejects when ssh ends or stays silent first. */
function readyPort(child: ChildProcess, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let output = "";
		let stderr = "";
		const finish = (result: number | Error) => {
			clearTimeout(timer);
			child.stdout?.removeListener("data", onData);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		const timer = setTimeout(
			() => finish(new Error(`The node's GUI did not report ready within ${Math.round(timeoutMs / 1000)} s.`)),
			timeoutMs,
		);
		timer.unref();
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > READY_OUTPUT_LIMIT) {
				finish(new Error("The node's GUI printed too much before reporting ready."));
				return;
			}
			const lines = output.split("\n");
			output = lines.pop() ?? "";
			for (const line of lines) {
				const port = parseReadyLine(line);
				if (port !== null) {
					finish(port);
					return;
				}
			}
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const last = stderr.trim().split("\n").at(-1) ?? "";
			finish(
				new Error(`ssh ended (${code ?? signal ?? "unknown"}) before the node's GUI was ready${last ? `: ${last}` : "."}`),
			);
		};
		const onError = (error: Error) => finish(new Error(`ssh could not start: ${error.message}`));
		child.stdout?.on("data", onData);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4096);
		});
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function sleep(ms: number) {
	await new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * One attachment per registered node: this app starts the node's own GUI over SSH on demand, forwards
 * a local port to it and proxies the browser there. The node's GUI stops itself when idle; this app
 * stops every channel when it stops.
 */
export class MachineAttachments implements MachineAttachmentsApi {
	private readonly entries = new Map<string, Entry>();
	private readonly startedAt = new Date().toISOString();
	private stopped = false;
	constructor(private readonly deps: MachineAttachDeps) {}

	async list(): Promise<MachineAttachment[]> {
		const endpoints = await this.deps.endpoints();
		return endpoints.map((endpoint) => this.entries.get(endpoint.id)?.attachment ?? this.detached(endpoint));
	}

	async attach(id: string): Promise<MachineAttachment> {
		if (this.stopped) throw new AppProblem("unavailable", "The app is stopping.");
		const endpoint = (await this.deps.endpoints()).find((candidate) => candidate.id === id);
		if (!endpoint) throw new AppProblem("not_found", `No fleet node is registered as ${id}.`);
		const current = this.entries.get(id);
		if (current && (current.attachment.state === "ready" || current.attachment.state === "connecting"))
			return current.attachment;
		// An explicit open starts over, whatever the earlier run ended in, and resets the backoff.
		return this.start(endpoint, 0).attachment;
	}

	route(id: string): MachineRoute | null {
		const entry = this.entries.get(id);
		if (!entry) return null;
		const state = entry.attachment.state;
		if (state !== "ready") return { kind: "pending", state };
		return entry.live?.localPort
			? { kind: "ready", port: entry.live.localPort, token: entry.live.token }
			: { kind: "pending", state: "connecting" };
	}

	async stopAll(): Promise<void> {
		this.stopped = true;
		const children: ChildProcess[] = [];
		for (const entry of this.entries.values()) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = null;
			children.push(...this.teardown(entry));
		}
		await Promise.race([Promise.all(children.map(exited)), sleep(2_000)]);
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}

	private detached(endpoint: MachineEndpoint): MachineAttachment {
		return {
			id: endpoint.id,
			host: endpoint.host,
			state: "detached",
			since: this.startedAt,
			detail: null,
			attempt: 0,
			retryAt: null,
			remote: null,
		};
	}

	private start(endpoint: MachineEndpoint, failures: number): Entry {
		const previous = this.entries.get(endpoint.id);
		if (previous?.timer) clearTimeout(previous.timer);
		const entry: Entry = {
			attachment: {
				...this.detached(endpoint),
				state: "connecting",
				since: new Date().toISOString(),
				attempt: failures,
			},
			live: {
				endpoint,
				// Fresh per attachment, delivered on stdin and kept only here; it never reaches a log or the browser.
				token: randomBytes(32).toString("base64url"),
				command: null,
				forward: null,
				localPort: null,
			},
			timer: null,
			failures,
			generation: (previous?.generation ?? 0) + 1,
		};
		this.entries.set(endpoint.id, entry);
		this.publish(entry);
		void this.connect(entry).catch((error: unknown) => {
			if (this.current(entry)) this.fail(entry, error instanceof Error ? error.message : String(error));
		});
		return entry;
	}

	private current(entry: Entry) {
		return !this.stopped && this.entries.get(entry.attachment.id) === entry;
	}

	private async connect(entry: Entry): Promise<void> {
		const live = entry.live;
		if (!live) return;
		const env = this.deps.env ?? process.env;
		const command = startSshCommand(
			live.endpoint,
			remoteGuiCommand(live.endpoint.clioCoderEntry, this.deps.idleMs ?? REMOTE_GUI_IDLE_MS),
			env,
		);
		live.command = command;
		// A channel that dies before reading its token raises EPIPE here; the exit itself is what gets reported.
		command.child.stdin?.on("error", () => {});
		command.child.stdin?.write(`${live.token}\n`);
		const remotePort = await readyPort(command.child, this.deps.readyTimeoutMs ?? 30_000);
		if (!this.current(entry)) return;
		// Keep the channel's pipes draining so the remote never blocks on a full pipe.
		command.child.stdout?.on("data", () => {});
		command.child.stderr?.on("data", () => {});
		command.child.once("exit", (code) => this.channelExited(entry, "command", code));
		const localPort = await freeLoopbackPort();
		if (!this.current(entry)) return;
		live.localPort = localPort;
		const forward = startSshForward(live.endpoint, localPort, remotePort, env);
		live.forward = forward;
		forward.child.stderr?.on("data", () => {});
		forward.child.once("exit", (code) => this.channelExited(entry, "forward", code));
		const remote = await this.waitForMeta(entry, localPort, live.token);
		if (!this.current(entry)) return;
		if (!remote) throw new Error("The node's GUI did not answer through the SSH forward.");
		const gate = versionGate(entry.attachment.id, this.deps.local(), remote);
		if (!gate.ok) {
			this.teardown(entry);
			entry.attachment = {
				...entry.attachment,
				state: "version-mismatch",
				since: new Date().toISOString(),
				detail: gate.detail,
				retryAt: null,
				remote,
			};
			this.publish(entry);
			return;
		}
		entry.failures = 0;
		entry.attachment = {
			...entry.attachment,
			state: "ready",
			since: new Date().toISOString(),
			detail: null,
			retryAt: null,
			remote,
		};
		this.publish(entry);
	}

	private async waitForMeta(entry: Entry, port: number, token: string): Promise<RemoteServerMeta | null> {
		const deadline = performance.now() + (this.deps.metaTimeoutMs ?? 10_000);
		while (performance.now() < deadline && this.current(entry)) {
			const meta = await remoteServerMeta(port, token);
			if (meta) return meta;
			await sleep(200);
		}
		return null;
	}

	private channelExited(entry: Entry, channel: "command" | "forward", code: number | null) {
		if (!this.current(entry) || entry.attachment.state !== "ready") return;
		// The node's GUI stopping itself after idling is the normal end; the next open starts it again.
		if (channel === "command" && code === 0) {
			this.teardown(entry);
			entry.attachment = {
				...entry.attachment,
				state: "detached",
				since: new Date().toISOString(),
				detail: null,
				retryAt: null,
				remote: null,
			};
			this.publish(entry);
			return;
		}
		this.fail(entry, `The SSH ${channel} channel to ${entry.attachment.host} ended (${code ?? "signal"}).`);
	}

	private fail(entry: Entry, detail: string) {
		this.teardown(entry);
		const failures = entry.failures + 1;
		entry.failures = failures;
		const delay = reconnectDelayMs(failures);
		entry.attachment = {
			...entry.attachment,
			state: "failed",
			since: new Date().toISOString(),
			detail: delay === null ? `${detail} Reconnecting stopped; open the machine again to retry.` : detail,
			attempt: failures,
			retryAt: delay === null ? null : new Date(Date.now() + delay).toISOString(),
			remote: null,
		};
		this.publish(entry);
		if (delay === null) return;
		const endpoint = entry.live?.endpoint;
		if (!endpoint) return;
		entry.timer = setTimeout(() => {
			entry.timer = null;
			if (this.current(entry)) this.start(endpoint, failures);
		}, delay);
		entry.timer.unref();
	}

	/** Stop both channels; stdin's end tells the node's GUI its parent is gone before any signal lands. */
	private teardown(entry: Entry): ChildProcess[] {
		const live = entry.live;
		if (!live) return [];
		const children: ChildProcess[] = [];
		for (const owned of [live.command, live.forward]) {
			if (!owned) continue;
			children.push(owned.child);
			owned.child.stdin?.end();
			stopClioCommand(owned.child, owned.birthToken, "SIGTERM");
			const child = owned.child,
				birthToken = owned.birthToken;
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) stopClioCommand(child, birthToken, "SIGKILL");
			}, 1_000).unref();
		}
		live.command = null;
		live.forward = null;
		live.localPort = null;
		return children;
	}

	private publish(entry: Entry) {
		this.deps.hub.publish({ type: "machine.attach", payload: entry.attachment });
	}
}
