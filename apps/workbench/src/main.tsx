import "@fontsource-variable/atkinson-hyperlegible-next/index.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource/commit-mono/400.css";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { createRoot } from "react-dom/client";
import { type WorkbenchActions, WorkbenchView } from "./App.tsx";
import { FrameEventBuffer } from "./event-buffer.ts";
import {
	type ClientCommand,
	type ClientCommandKind,
	type ClientCommandPayloadByKind,
	type LocalTransport,
	PROTOCOL_VERSION,
	WebSocketLocalTransport,
} from "./protocol.ts";
import { appReducer, initialAppState, parseBootstrapPayload } from "./state.ts";
import "./styles.css";

function App() {
	const [state, dispatch] = useReducer(appReducer, initialAppState);
	const transportRef = useRef<LocalTransport | null>(null);

	useEffect(() => {
		const abortController = new AbortController();
		let mounted = true;
		let transport: LocalTransport | null = null;
		let eventBuffer: FrameEventBuffer | null = null;

		async function connect() {
			try {
				const response = await fetch("/api/bootstrap", {
					headers: { accept: "application/json" },
					cache: "no-store",
					credentials: "same-origin",
					signal: abortController.signal,
				});
				if (!response.ok) throw new Error(`Bootstrap failed with HTTP ${response.status}.`);
				const bootstrap = parseBootstrapPayload(await response.json());
				if (!mounted) return;
				dispatch({ type: "bootstrap.loaded", payload: bootstrap });

				const endpoint = new URL("/api/events", location.href);
				endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
				endpoint.searchParams.set("token", bootstrap.localToken);
				transport = new WebSocketLocalTransport(endpoint);
				transportRef.current = transport;
				eventBuffer = new FrameEventBuffer((events) => {
					if (mounted) dispatch({ type: "host.events", events });
				});
				transport.onEvent((event) => {
					if (!mounted) return;
					eventBuffer?.push(event);
				});
				transport.onDisconnect((disconnect) => {
					if (!mounted || disconnect.cause === "client-close") return;
					eventBuffer?.flush();
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
			eventBuffer?.close();
			transport?.close(1000, "Workbench renderer closed");
			if (transportRef.current === transport) transportRef.current = null;
		};
	}, []);

	const actions = useMemo<WorkbenchActions>(() => {
		function send<K extends ClientCommandKind>(kind: K, payload: ClientCommandPayloadByKind[K]): string | null {
			const transport = transportRef.current;
			if (!transport || transport.state !== "open") {
				dispatch({
					type: "notice.raised",
					tone: "warning",
					message: "The local control channel is not ready yet. Wait for the connected status and try again.",
				});
				return null;
			}
			const requestId = `request-${crypto.randomUUID()}`;
			const command = { protocolVersion: PROTOCOL_VERSION, requestId, kind, payload } as ClientCommand;
			try {
				transport.send(command);
				return requestId;
			} catch (error) {
				dispatch({
					type: "notice.raised",
					tone: "error",
					message: error instanceof Error ? error.message : "The local command could not be sent.",
				});
				return null;
			}
		}

		return {
			browseProjects(path) {
				send("project.browse", path === undefined ? {} : { path });
			},
			openProject(path) {
				send("project.open", { path });
			},
			selectProject(projectId) {
				const requestId = send("project.select", { projectId });
				if (requestId !== null) dispatch({ type: "project.select.submitted", requestId, projectId });
			},
			forgetProject(projectId) {
				send("project.forget", { projectId });
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
			newSession(projectId) {
				send("session.new", { projectId });
			},
			loadSession(projectId, sessionId) {
				send("session.load", { projectId, sessionId });
			},
			closeSession(projectId) {
				send("session.close", { projectId });
			},
			listSessions(projectId) {
				send("session.list", { projectId });
			},
			labelSession(projectId, sessionId, label) {
				send("session.label", { projectId, sessionId, label });
			},
			deleteSession(projectId, sessionId) {
				send("session.delete", { projectId, sessionId });
			},
			startTurn(projectId, prompt) {
				const requestId = send("turn.start", { projectId, prompt });
				if (requestId !== null) dispatch({ type: "turn.submitted", requestId });
			},
			cancelTurn(projectId, turnId) {
				send("turn.cancel", { projectId, turnId });
			},
			resolvePermission(projectId, turnId, permissionId, decision) {
				send("permission.resolve", { projectId, turnId, permissionId, decision });
			},
			getSettings(projectId) {
				send("settings.get", { projectId });
			},
			patchSettings(projectId, patch) {
				send("settings.patch", { projectId, patch });
			},
			inspectConfig(projectId) {
				const requestId = send("config.inspect", { projectId });
				if (requestId !== null) dispatch({ type: "config.inspect.submitted", requestId });
			},
			inspectCatalog(projectId) {
				const requestId = send("catalog.inspect", { projectId });
				if (requestId !== null) dispatch({ type: "catalog.inspect.submitted", requestId });
			},
			listTargets(projectId) {
				send("targets.list", { projectId });
			},
			probeTarget(projectId, targetId) {
				send("targets.probe", { projectId, targetId });
			},
			setAutonomy(projectId, level) {
				send("autonomy.set", { projectId, level });
			},
		};
	}, []);

	return <WorkbenchView state={state} dispatch={dispatch} actions={actions} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Clio Workbench could not find its root element.");
createRoot(rootElement).render(<App />);
