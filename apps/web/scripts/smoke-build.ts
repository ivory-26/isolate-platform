import { strict as assert } from "node:assert";

import { fileURLToPath } from "node:url";

if (!Bun.argv.includes("--isolated")) {
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			fileURLToPath(import.meta.url),
			"--isolated",
		],
		{
			env: {
				NODE_ENV: "production",
				WEB_LOCAL_DEMO: "true",
				DATABASE_URL: "postgres://invalid.invalid/offline-sentinel",
			},
			stdout: "inherit",
			stderr: "inherit",
			timeout: 20_000,
		},
	);
	assert.equal(await child.exited, 0, "Isolated production smoke failed");
} else {
	// Only the isolated child imports the server; host secrets are never inherited.
	const entry = new URL("../dist/server/server.js", import.meta.url).href;
	const { default: server } = await import(entry);
	for (const path of ["/", "/runs"]) {
		const response: Response = await server.fetch(
			new Request(`http://localhost:3000${path}`, {
				headers: {
					"x-organization-id": "20000000-0000-4000-8000-000000000001",
					"x-user-id": "20000000-0000-4000-8000-000000000002",
				},
			}),
		);
		assert.equal(response.status, 200, `SSR status for ${path}`);
		assert(
			response.headers.get("cache-control")?.includes("no-store"),
			"SSR must not enter shared caches",
		);
		const html = await response.text();
		assert(
			html.includes("Task control plane") || html.includes("Latest tasks"),
			"Expected route content",
		);
		if (path === "/runs") {
			assert(
				html.includes(
					"Task access is disabled until trusted authentication is configured",
				),
				"Production must ignore spoofed caller headers and local demo flag",
			);
		}
		console.log("Production SSR passed:", path);
	}
}
