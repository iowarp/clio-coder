import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { createClient } from "./api/client.js";
import { launchToken } from "./api/token.js";
import { App } from "./app.js";
import { Home } from "./pages/home.js";
import { Toolchain } from "./pages/toolchain.js";
import { TraceRunPage } from "./pages/traces/run.js";
import { TraceRuns } from "./pages/traces/runs.js";
import "./styles.css";

const client = createClient(launchToken());
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const router = createBrowserRouter([
	{
		element: <App client={client} />,
		children: [
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
