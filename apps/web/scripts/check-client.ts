import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../dist/client/", import.meta.url);
const forbidden = [
	"apiKey",
	"DATABASE_URL",
	"postgres://",
	"postgresql://",
	"api.openai.com",
	"api.anthropic.com",
	"generativelanguage.googleapis.com",
	"api.groq.com",
	"@isolate/db",
	"@isolate/workflow-schema",
	"compileWorkflow",
	"createWorkflowCompilationService",
	"getAuthoredVersion",
	"@mastra/",
	"@e2b/",
	"node:child_process",
	"PostgresTaskRepository",
	"InMemoryTaskRepository",
	"createDb(",
	"-----BEGIN PRIVATE KEY-----",
	"-----BEGIN RSA PRIVATE KEY-----",
];
const names = await readdir(root, { recursive: true, withFileTypes: true });
const files = names.filter((entry) => entry.isFile());
assert(files.length > 0, "Build dist/client before running the sweep");
let bytes = 0;
for (const file of files) {
	const path = `${file.parentPath}/${file.name}`;
	const content = await readFile(path);
	bytes += content.byteLength;
	const text = content.toString("utf8").toLowerCase();
	for (const token of forbidden)
		assert(
			!text.includes(token.toLowerCase()),
			`Forbidden client token ${token} in ${path}`,
		);
	assert(
		!/sk-(?:proj-|ant-)?[a-z0-9_-]{24,}/i.test(text),
		`Token-shaped value in ${path}`,
	);
}
console.log("Client sweep passed", {
	root: fileURLToPath(root),
	files: files.length,
	bytes,
	checks: forbidden.length + 1,
});
