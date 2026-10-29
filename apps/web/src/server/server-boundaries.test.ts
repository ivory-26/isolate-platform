import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const serverDirectory = import.meta.dir;
const serverOnlyImport = 'import "@tanstack/react-start/server-only";';

describe("server boundary", () => {
	test("every server module keeps the server-only boundary", async () => {
		const files = (await readdir(serverDirectory)).filter((file) =>
			file.endsWith(".server.ts"),
		);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = await readFile(join(serverDirectory, file), "utf8");
			expect({ file, firstLine: source.split("\n")[0] }).toEqual({
				file,
				firstLine: serverOnlyImport,
			});
		}
	});
	test("submit and list server functions keep private no-store headers", async () => {
		const source = await readFile(
			join(serverDirectory, "..", "features", "tasks", "tasks.functions.ts"),
			"utf8",
		);
		expect(
			source.match(
				/setResponseHeader\("Cache-Control", "private, no-store"\)/g,
			),
		).toHaveLength(2);
	});
});
