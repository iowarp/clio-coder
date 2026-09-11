import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { createClient } from "./api/client.js";
import { launchToken } from "./api/token.js";
import { App } from "./app.js";
import { reportProblem } from "./design/problems.js";
import { Docs } from "./pages/docs.js";
import { EvidenceDetail, EvidencePage } from "./pages/evidence.js";
import { FleetDetail, FleetPage } from "./pages/fleet.js";
import { Home } from "./pages/home.js";
import { Session, Sessions, Workspaces } from "./pages/sessions.js";
import { SettingsPage } from "./pages/settings.js";
import { TargetsPage } from "./pages/targets.js";
import { Toolchain } from "./pages/toolchain.js";
import { TraceRunPage } from "./pages/traces/run.js";
import { TraceRuns } from "./pages/traces/runs.js";
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
const router = createBrowserRouter([
	{
		element: <App client={client} />,
		children: [
			{ path: "/evidence", element: <EvidencePage client={client} /> },
			{ path: "/evidence/:id", element: <EvidenceDetail client={client} /> },
			{ path: "/fleet", element: <FleetPage client={client} /> },
			{ path: "/fleet/:id", element: <FleetDetail client={client} /> },
			{ path: "/fleet/dispatches/:id", element: <FleetDetail client={client} dispatch /> },
			{ path: "/settings/targets", element: <TargetsPage client={client} view="targets" /> },
			{ path: "/settings/routing", element: <TargetsPage client={client} view="routing" /> },
			{ path: "/settings", element: <SettingsPage client={client} view="settings" /> },
			{ path: "/settings/why", element: <SettingsPage client={client} view="why" /> },
			{ path: "/docs/*", element: <Docs client={client} /> },
			{ path: "/sessions", element: <Workspaces client={client} /> },
			{ path: "/workspaces/:workspaceId/sessions", element: <Sessions client={client} /> },
			{ path: "/sessions/:id", element: <Session client={client} /> },
			{ path: "/", element: <Home /> },
			{ path: "/traces", element: <TraceRuns client={client} /> },
			{ path: "/traces/:runId", element: <TraceRunPage client={client} /> },
			{ path: "/toolchain", element: <Toolchain client={client} /> },
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
