import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Repository security loop (wave 17).
 *
 * Enforces the credential boundary: provider keys stay on the user's device,
 * so no source or migration may reintroduce server-side secret storage. Also
 * rejects committed env files, private keys and real-looking provider tokens.
 *
 * Run with `bun run security:check`. Exit 1 on any finding.
 */

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
	.split(/\r?\n/)
	.filter((line) => line.length > 0);

const findings: string[] = [];

const sourceFiles = tracked.filter(
	(file) =>
		(/^(apps|packages)\/.+\/src\/.+\.(ts|tsx)$/.test(file) &&
			!file.endsWith(".test.ts") &&
			!file.endsWith(".test.tsx")) ||
		/^packages\/db\/migrations\/.+\.sql$/.test(file),
);

const forbidden: Array<{ label: string; pattern: RegExp }> = [
	{
		label: "server-side connector key",
		pattern: /CONNECTOR_CREDENTIAL_KEY/,
	},
	{
		label: "server-side encrypted credential column",
		pattern: /encrypted_payload|wrapped_dek/,
	},
	{
		label: "private key block",
		// A real PEM body, not a `-----BEGIN ...-----` detection regex in code.
		pattern:
			/-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{100,}-----END/,
	},
	{
		label: "GitHub token",
		pattern: /gh[pousr]_[A-Za-z0-9]{20,}/,
	},
	{
		label: "GitHub fine-grained token",
		pattern: /github_pat_[A-Za-z0-9_]{20,}/,
	},
	{
		label: "Slack bot token",
		pattern: /xox[bp]-[A-Za-z0-9-]{20,}/,
	},
	{
		label: "AWS access key id",
		pattern: /AKIA[0-9A-Z]{16}/,
	},
];

for (const file of sourceFiles) {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	const scannable = file.endsWith(".sql")
		? text
				.split(/\r?\n/)
				.filter((line) => !line.trimStart().startsWith("--"))
				.join("\n")
		: text;
	for (const rule of forbidden) {
		if (rule.pattern.test(scannable)) {
			findings.push(`${file}: ${rule.label}`);
		}
	}
}

for (const file of tracked) {
	if (/^\.env(\.|$)/.test(file) && file !== ".env.example") {
		findings.push(`${file}: environment file is tracked`);
	}
	if (/\.pem$/i.test(file)) {
		findings.push(`${file}: private key file is tracked`);
	}
}

const migration = readFileSync(
	"packages/db/migrations/0010_connectors.sql",
	"utf8",
);
for (const required of ["connector_devices", "credential_ref", "token_hash"]) {
	if (!migration.includes(required)) {
		findings.push(
			`packages/db/migrations/0010_connectors.sql: missing ${required}`,
		);
	}
}
const migrationDdl = migration
	.split(/\r?\n/)
	.filter((line) => !line.trimStart().startsWith("--"))
	.join("\n");
for (const forbiddenColumn of [
	"encrypted_payload",
	"wrapped_dek",
	"key_version",
]) {
	if (migrationDdl.includes(forbiddenColumn)) {
		findings.push(
			`packages/db/migrations/0010_connectors.sql: forbidden server secret column ${forbiddenColumn}`,
		);
	}
}

if (findings.length > 0) {
	console.error("SECURITY CHECK FAILED");
	for (const finding of findings) console.error(` - ${finding}`);
	process.exit(1);
}

console.log(
	`SECURITY CHECK PASSED (${sourceFiles.length} source/migration files, ${tracked.length} tracked files)`,
);
