import { describe, expect, test } from "bun:test";
import { validateSandboxEnv } from "./env";

const valid = {
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
	GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic dGVzdA==",
};

function tooManyKeys(): Record<string, string> {
	const env: Record<string, string> = {};
	for (let index = 0; index < 17; index++) env[`KEY_${index}`] = "v";
	return env;
}

function expectDenied(env: unknown): void {
	let thrown: unknown;
	try {
		validateSandboxEnv(env);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toMatchObject({ code: "POLICY_DENIED" });
}

describe("validateSandboxEnv", () => {
	test("accepts an absent environment", () => {
		expect(validateSandboxEnv(undefined)).toBeUndefined();
	});

	test("returns a frozen copy of a valid environment", () => {
		const env = validateSandboxEnv(valid);
		expect(env).toEqual(valid);
		expect(env).not.toBe(valid);
		expect(Object.isFrozen(env)).toBe(true);
	});

	test("accepts exactly sixteen keys", () => {
		const env: Record<string, string> = {};
		for (let index = 0; index < 16; index++) env[`KEY_${index}`] = "v";
		expect(Object.keys(validateSandboxEnv(env) ?? {})).toHaveLength(16);
	});

	test.each([
		["seventeen keys", tooManyKeys()],
		["lowercase name", { git_config_count: "1" }],
		["leading digit", { "1KEY": "v" }],
		["leading underscore", { _KEY: "v" }],
		["hyphen", { "GIT-CONFIG": "v" }],
		["space", { "GIT CONFIG": "v" }],
		["empty name", { "": "v" }],
		["oversized name", { [`K${"E".repeat(64)}`]: "v" }],
		["non-string value", { KEY: 1 }],
		["oversized value", { KEY: "v".repeat(4097) }],
		["newline value", { KEY: "a\nb" }],
		["nul value", { KEY: "a\u0000b" }],
		["delete value", { KEY: "a\u007fb" }],
		["array", ["a"]],
		["null", null],
		["string", "KEY=value"],
	] as const)("rejects %s", (_label, env) => {
		expectDenied(env);
	});

	test("accepts value and name at the exact limits", () => {
		const name = `K${"E".repeat(63)}`;
		const env = validateSandboxEnv({ [name]: "v".repeat(4096) }) ?? {};
		expect(env[name]).toBe("v".repeat(4096));
	});
});
