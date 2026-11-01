import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	// Configuration is injected by deployment; never load local secret files.
	envDir: false,
	server: { port: 3000, host: "127.0.0.1" },
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
