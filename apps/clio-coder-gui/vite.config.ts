import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL("./client", import.meta.url)),
	plugins: [react()],
	build: {
		outDir: "../dist/client",
		emptyOutDir: true,
		license: { fileName: "THIRD_PARTY_LICENSES.md" },
		// Mermaid's lazily loaded shared core is one 662 kB upstream chunk; every other chunk stays under the default 500 kB.
		chunkSizeWarningLimit: 700,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [{ name: "framework", test: /node_modules[\\/](react|react-dom|react-router|scheduler|@tanstack)[\\/]/ }],
				},
			},
		},
	},
	server: {
		port: 4318,
		strictPort: true,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:4317",
				changeOrigin: true,
				configure(proxy) {
					proxy.on("proxyReq", (request, incoming) => {
						if (incoming.headers.origin === "http://127.0.0.1:4318") request.setHeader("Origin", "http://127.0.0.1:4317");
					});
				},
			},
		},
	},
});
