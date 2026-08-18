import "@fontsource-variable/atkinson-hyperlegible-next/index.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource/commit-mono/400.css";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { createRoot } from "react-dom/client";
import { type WorkbenchActions, WorkbenchView } from "./App.tsx";
import {
	type ClientCommand,
	type ClientCommandKind,
	type ClientCommandPayloadByKind,
	type LocalTransport,
	PROTOCOL_VERSION,
	WebSocketLocalTransport,
} from "./protocol.ts";
import { appReducer, type HostEventLike, initialAppState, parseBootstrapPayload } from "./state.ts";
import "./styles.css";

const BOOTSTRAP_RETRY_STATUS = 409;
const BOOTSTRAP_RETRY_DELAY_MS = 50;
const BOOTSTRAP_RETRY_WINDOW_MS = 15_000;

async function requestBootstrap(signal: AbortSignal): Promise<Response> {
	const deadline = Date.now() + BOOTSTRAP_RETRY_WINDOW_MS;
	for (;;) {
		const response = await fetch("/api/bootstrap", {
			headers: { accept: "application/json" },
			cache: "no-store",
			credentials: "same-origin",
			signal,
		});
		if (response.status !== BOOTSTRAP_RETRY_STATUS) return response;
		await response.body?.cancel();
		if (Date.now() >= deadline) {
			throw new Error("Bootstrap timed out while Workbench settled the previous local control session.");
		}
		await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_RETRY_DELAY_MS));
		if (signal.aborted) throw signal.reason;
	}
}

function App() {
	const [state, dispatch] = useReducer(appReducer, initialAppState);
	const transportRef = useRef<LocalTransport | null>(null);

	useEffect(() => {
		const abortController = new AbortController();
		let mounted = true;
		let transport: LocalTransport | null = null;

		async function connect() {
			try {
				const response = await requestBootstrap(abortController.signal);
				if (!response.ok) throw new Error(`Bootstrap failed with HTTP ${response.status}.`);
				const bootstrap = parseBootstrapPayload(await response.json());
				if (!mounted) return;
				dispatch({ type: "bootstrap.loaded", payload: bootstrap });

				const endpoint = new URL("/api/events", location.href);
				endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
				endpoint.searchParams.set("token", bootstrap.localToken);
				transport = new WebSocketLocalTransport(endpoint);
				transportRef.current = transport;
				transport.onEvent((event) => {
					if (!mounted) return;
					if (event.kind === "connection.ready") {
						dispatch({ type: "connection.changed", connection: "connected" });
						return;
					}
					dispatch({ type: "host.event", event: event as unknown as HostEventLike });
				});
				transport.onDisconnect((disconnect) => {
					if (!mounted || disconnect.cause === "client-close") return;
					dispatch({
						type: "connection.changed",
						connection: disconnect.cause === "protocol-error" ? "failed" : "disconnected",
					});
					dispatch({
						type: "notice.raised",
						tone: "error",
						message: `The local event channel closed (${disconnect.code}): ${disconnect.reason || disconnect.cause}`,
					});
				});
			} catch (error) {
				if (!mounted || abortController.signal.aborted) return;
				dispatch({
					type: "bootstrap.failed",
					message: error instanceof Error ? error.message : "The Workbench bootstrap request failed.",
				});
			}
		}

		void connect();
		return () => {
			mounted = false;
			abortController.abort();
			transport?.close(1000, "Workbench renderer closed");
			if (transportRef.current === transport) transportRef.current = null;
		};
	}, []);

	const actions = useMemo<WorkbenchActions>(() => {
		function send<K extends ClientCommandKind>(kind: K, payload: ClientCommandPayloadByKind[K]): void {
			const transport = transportRef.current;
			if (!transport || transport.state !== "open") {
				dispatch({
					type: "notice.raised",
					tone: "warning",
					message: "The local control channel is not ready yet. Wait for the connected status and try again.",
				});
				return;
			}
			const command = {
				protocolVersion: PROTOCOL_VERSION,
				requestId: `request-${crypto.randomUUID()}`,
				kind,
				payload,
			} as ClientCommand;
			try {
				transport.send(command);
			} catch (error) {
				dispatch({
					type: "notice.raised",
					tone: "error",
					message: error instanceof Error ? error.message : "The local command could not be sent.",
				});
			}
		}

		return {
			selectProject(projectId) {
				send("project.select", { projectId });
			},
			selectEngine(projectId, kind) {
				send("engine.select", { projectId, kind });
			},
			probeEngine(projectId) {
				send("engine.probe", { projectId });
			},
			startTurn(projectId, prompt, fakeScenario) {
				send("turn.start", {
					projectId,
					prompt,
					...(fakeScenario === undefined ? {} : { fakeScenario }),
				});
			},
			cancelTurn(projectId, turnId) {
				send("turn.cancel", { projectId, turnId });
			},
			resolvePermission(projectId, turnId, permissionId, decision) {
				send("permission.resolve", { projectId, turnId, permissionId, decision });
			},
			createProject(displayName, directoryName) {
				send("project.create", { displayName, directoryName });
			},
			registerProject(relativeRoot, displayName) {
				send("project.register", { relativeRoot, ...(displayName === undefined ? {} : { displayName }) });
			},
			refreshTree(projectId, directory = []) {
				send("fs.refresh", { projectId, directory });
			},
			createNode(projectId, parent, name, kind) {
				if (kind === "file") send("fs.create-file", { projectId, parent, name });
				else send("fs.create-folder", { projectId, parent, name });
			},
			moveNode(projectId, source, destination, expectedNodeVersion) {
				send("fs.move", {
					projectId,
					source,
					destination,
					...(expectedNodeVersion === undefined ? {} : { expectedNodeVersion }),
				});
			},
			prepareDelete(projectId, target, expectedNodeVersion) {
				send("fs.delete.prepare", {
					projectId,
					target,
					...(expectedNodeVersion === undefined ? {} : { expectedNodeVersion }),
				});
			},
			confirmDelete(projectId, confirmationId) {
				send("fs.delete.confirm", { projectId, confirmationId });
			},
		};
	}, []);

	return <WorkbenchView state={state} dispatch={dispatch} actions={actions} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Clio Workbench could not find its root element.");
createRoot(rootElement).render(<App />);
