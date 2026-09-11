import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL("./client", import.meta.url)),
	plugins: [react()],
	build: { outDir: "../dist/client", emptyOutDir: true, license: { fileName: "THIRD_PARTY_LICENSES.md" } },
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
