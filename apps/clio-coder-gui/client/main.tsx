import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { createClient } from "./api/client.js";
import { launchToken } from "./api/token.js";
import { App } from "./app.js";
import { reportProblem } from "./design/notifications.js";
import { Home } from "./pages/home.js";
import "./styles.css";
import "@fontsource-variable/atkinson-hyperlegible-next/index.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource/commit-mono/latin-400.css";
import "./design/tokens.css";
import "./render/markdown.css";

const client = createClient(launchToken());
const queries = new QueryClient({
	defaultOptions: { queries: { retry: false } },
	queryCache: new QueryCache({ onError: reportProblem }),
	mutationCache: new MutationCache({ onError: reportProblem }),
});
function RouteError() {
	return (
		<main className="route-error" role="alert">
			<p className="eyebrow">Clio Coder</p>
			<h1>This view could not open.</h1>
			<p>Check the local connection and reload the app.</p>
			<button type="button" className="primary" onClick={() => window.location.reload()}>
				Reload app
			</button>
		</main>
	);
}
const router = createBrowserRouter([
	{
		element: <App client={client} />,
		errorElement: <RouteError />,
		children: [
			{
				path: "/evidence",
				lazy: async () => {
					const { EvidencePage } = await import("./pages/evidence.js");
					return { element: <EvidencePage client={client} /> };
				},
			},
			{
				path: "/evidence/:id",
				lazy: async () => {
					const { EvidenceDetail } = await import("./pages/evidence.js");
					return { element: <EvidenceDetail client={client} /> };
				},
			},
			{
				path: "/usage",
				lazy: async () => {
					const { UsagePage } = await import("./pages/reports.js");
					return { element: <UsagePage client={client} /> };
				},
			},
			{
				path: "/library",
				lazy: async () => {
					const { LibraryPage } = await import("./pages/library.js");
					return { element: <LibraryPage client={client} /> };
				},
			},
			{
				path: "/system",
				lazy: async () => {
					const { SystemPage } = await import("./pages/system.js");
					return { element: <SystemPage client={client} /> };
				},
			},
			{
				path: "/system/interop",
				lazy: async () => {
					const { InteropPage } = await import("./pages/system.js");
					return { element: <InteropPage client={client} /> };
				},
			},
			{
				path: "/fleet",
				lazy: async () => {
					const { FleetPage } = await import("./pages/fleet.js");
					return { element: <FleetPage client={client} /> };
				},
			},
			{
				path: "/fleet/:id",
				lazy: async () => {
					const { FleetDetail } = await import("./pages/fleet.js");
					return { element: <FleetDetail client={client} /> };
				},
			},
			{
				path: "/fleet/dispatches/:id",
				lazy: async () => {
					const { FleetDetail } = await import("./pages/fleet.js");
					return { element: <FleetDetail client={client} dispatch /> };
				},
			},
			{
				path: "/settings/targets",
				lazy: async () => {
					const { TargetsPage } = await import("./pages/targets.js");
					return { element: <TargetsPage client={client} view="targets" /> };
				},
			},
			{
				path: "/settings/routing",
				lazy: async () => {
					const { TargetsPage } = await import("./pages/targets.js");
					return { element: <TargetsPage client={client} view="routing" /> };
				},
			},
			{
				path: "/settings",
				lazy: async () => {
					const { SettingsPage } = await import("./pages/settings.js");
					return { element: <SettingsPage client={client} view="settings" /> };
				},
			},
			{
				path: "/settings/effective",
				lazy: async () => {
					const { SettingsPage } = await import("./pages/settings.js");
					return { element: <SettingsPage client={client} view="effective" /> };
				},
			},
			{
				path: "/settings/why",
				lazy: async () => {
					const { SettingsPage } = await import("./pages/settings.js");
					return { element: <SettingsPage client={client} view="why" /> };
				},
			},
			{
				path: "/docs/*",
				lazy: async () => {
					const { Docs } = await import("./pages/docs.js");
					return { element: <Docs client={client} /> };
				},
			},
			{
				path: "/sessions",
				lazy: async () => {
					const { Workspaces } = await import("./pages/sessions.js");
					return { element: <Workspaces client={client} /> };
				},
			},
			{
				path: "/workspaces/:workspaceId/sessions",
				lazy: async () => {
					const { Sessions } = await import("./pages/sessions.js");
					return { element: <Sessions client={client} /> };
				},
			},
			{
				path: "/sessions/:id",
				lazy: async () => {
					const { Session } = await import("./pages/sessions.js");
					return { element: <Session client={client} /> };
				},
			},
			{ path: "/", element: <Home client={client} /> },
			{
				path: "/traces",
				lazy: async () => {
					const { TraceRuns } = await import("./pages/traces/runs.js");
					return { element: <TraceRuns client={client} /> };
				},
			},
			{
				path: "/traces/:runId",
				lazy: async () => {
					const { TraceRunPage } = await import("./pages/traces/run.js");
					return { element: <TraceRunPage client={client} /> };
				},
			},
			{
				path: "/toolchain",
				lazy: async () => {
					const { Toolchain } = await import("./pages/toolchain.js");
					return { element: <Toolchain client={client} /> };
				},
			},
		],
	},
]);
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(
	<QueryClientProvider client={queries}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
