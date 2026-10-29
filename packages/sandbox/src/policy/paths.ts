import { deny } from "../errors";

/** Sandbox paths are canonical POSIX paths, never paths on the worker host. */
export function validateAbsolutePath(value: string): string {
	if (
		typeof value !== "string" ||
		value.length > 1024 ||
		!value.startsWith("/") ||
		value === "/" ||
		value
			.split("/")
			.slice(1)
			.some(
				(part) =>
					!/^[a-zA-Z0-9_][a-zA-Z0-9_. -]{0,127}$/.test(part) ||
					part.endsWith(".") ||
					part.endsWith(" "),
			)
	)
		deny("Expected a canonical absolute sandbox path");
	return value;
}

export function validateSandboxPath(root: string, value: string): string {
	validateAbsolutePath(root);
	validateAbsolutePath(value);
	if (value !== root && !value.startsWith(`${root}/`))
		deny("Path is outside the sandbox workspace");
	return value;
}
