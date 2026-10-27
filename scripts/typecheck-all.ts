/**
 * Runs `tsc --noEmit` for every workspace project that currently exists.
 * `apps/web` returns when the post-kickoff UI scaffold lands; its absence is
 * not an error.
 */
const candidates = [
	"packages/shared",
	"packages/db",
	"packages/mastra",
	"packages/workflow-schema",
	"packages/integrations",
	"packages/sandbox",
	"apps/worker",
	"apps/web",
];

let failed = false;
const projects: string[] = [];
for (const project of candidates) {
	if (await Bun.file(`${project}/tsconfig.json`).exists()) projects.push(project);
}

for (const project of projects) {
	console.log(`typecheck: ${project}`);
	try {
		await Bun.$`bunx --bun tsc -p ${project}/tsconfig.json --noEmit`;
	} catch {
		console.error(`typecheck FAILED: ${project}`);
		failed = true;
	}
}

if (failed) process.exit(1);
console.log(`typecheck: all ${projects.length} projects passed`);
