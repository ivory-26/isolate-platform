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
	for (const path of ["/", "/runs", "/organizations"]) {
		const response: Response = await server.fetch(
			new Request(`http://localhost:3000${path}`, {
				redirect: "manual",
				headers: {
					"x-organization-id": "20000000-0000-4000-8000-000000000001",
					"x-user-id": "20000000-0000-4000-8000-000000000002",
				},
			}),
		);
		// Spoofed caller headers are never identity. Without a trusted session
		// the tenant routes must not render another tenant's data at all.
		assert.equal(response.status, 307, `SSR redirect for ${path}`);
		assert(
			response.headers.get("location")?.includes("/login"),
			`Expected a sign-in redirect for ${path}`,
		);
		console.log("Production SSR refused anonymous access:", path);
	}
	const login: Response = await server.fetch(
		new Request("http://localhost:3000/login", { redirect: "manual" }),
	);
	assert.equal(login.status, 200, "SSR status for /login");
	assert(
		login.headers.get("cache-control")?.includes("no-store"),
		"SSR must not enter shared caches",
	);
	const html = await login.text();
	assert(html.includes("Sign in"), "Expected the sign-in page");
	console.log("Production SSR passed: /login");
}
