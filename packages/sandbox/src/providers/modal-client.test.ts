import { describe, expect, test } from "bun:test";
import type { ModalCreateParams } from "./modal";
import {
	createModalSandboxClient,
	DEFAULT_MODAL_IMAGE,
	type ModalSdkModule,
	type ModalSdkProcess,
	type ModalSdkSandbox,
} from "./modal-client";

interface SdkCalls {
	constructorParams: Array<{ tokenId: string; tokenSecret: string }>;
	fromRegistry: string[];
	fromName: Array<{ name: string; params?: { createIfMissing?: boolean } }>;
	create: Array<{ app: unknown; image: unknown; params: ModalCreateParams }>;
}

interface ExecCall {
	readonly argv: string[];
	readonly params: { timeoutMs: number; workdir: string };
}

interface FakeSdkOptions {
	readonly sandbox?: ModalSdkSandbox;
	readonly createError?: unknown;
	readonly appError?: unknown;
}

function fakeSdk(options: FakeSdkOptions = {}) {
	const calls: SdkCalls = {
		constructorParams: [],
		fromRegistry: [],
		fromName: [],
		create: [],
	};
	const sandbox: ModalSdkSandbox = options.sandbox ?? {
		sandboxId: "sb-1",
		exec: async () => fakeProcess(),
		terminate: async () => {},
	};
	class FakeModalClient {
		readonly apps = {
			fromName: async (
				name: string,
				params?: { createIfMissing?: boolean },
			) => {
				calls.fromName.push({ name, params });
				if (options.appError) throw options.appError;
				return { name };
			},
		};
		readonly images = {
			fromRegistry: (tag: string) => {
				calls.fromRegistry.push(tag);
				return { tag };
			},
		};
		readonly sandboxes = {
			create: async (
				app: unknown,
				image: unknown,
				params: ModalCreateParams,
			) => {
				calls.create.push({ app, image, params });
				if (options.createError) throw options.createError;
				return sandbox;
			},
		};
		constructor(params: { tokenId: string; tokenSecret: string }) {
			calls.constructorParams.push(params);
		}
	}
	const module: ModalSdkModule = { ModalClient: FakeModalClient };
	return { module, calls, sandbox };
}

function fakeProcess(
	overrides: {
		stdout?: () => Promise<string>;
		stderr?: () => Promise<string>;
		wait?: () => Promise<number>;
	} = {},
): ModalSdkProcess {
	return {
		stdout: { readText: overrides.stdout ?? (async () => "out") },
		stderr: { readText: overrides.stderr ?? (async () => "err") },
		wait: overrides.wait ?? (async () => 0),
	};
}

function fakeSandbox(
	handlers: {
		exec?: (
			argv: string[],
			params: { timeoutMs: number; workdir: string },
		) => Promise<ModalSdkProcess>;
		terminate?: () => Promise<void>;
	} = {},
) {
	const calls = {
		exec: [] as ExecCall[],
		terminate: 0,
	};
	const sandbox: ModalSdkSandbox = {
		sandboxId: "sb-1",
		exec: async (argv, params) => {
			calls.exec.push({ argv, params });
			return handlers.exec ? handlers.exec(argv, params) : fakeProcess();
		},
		terminate: async () => {
			calls.terminate++;
			if (handlers.terminate) await handlers.terminate();
		},
	};
	return { sandbox, calls };
}

const env = {
	tokenId: "test-token-id",
	tokenSecret: "test-token-secret",
	appName: "isolate-test",
};

const createParams: ModalCreateParams = {
	cpu: 1,
	memoryMiB: 512,
	timeoutMs: 60_000,
	idleTimeoutMs: 30_000,
	workdir: "/workspace",
	command: ["sleep", "48h"],
	blockNetwork: true,
};

describe("createModalSandboxClient configuration", () => {
	test.each([
		["empty token id", { ...env, tokenId: "" }],
		["blank token secret", { ...env, tokenSecret: "   " }],
		["empty app name", { ...env, appName: "" }],
		["empty image", { ...env, image: "" }],
		["image with whitespace", { ...env, image: "node 22" }],
	] as const)("fails closed on %s without loading the SDK", async (_label, badEnv) => {
		let loaded = false;
		await expect(
			createModalSandboxClient(badEnv, async () => {
				loaded = true;
				return fakeSdk().module;
			}),
		).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
		expect(loaded).toBe(false);
	});

	test("constructs the SDK client and resolves the image without touching the network", async () => {
		const { module, calls } = fakeSdk();
		const client = await createModalSandboxClient(env, async () => module);
		expect(client).toBeDefined();
		expect(calls.constructorParams).toEqual([
			{ tokenId: "test-token-id", tokenSecret: "test-token-secret" },
		]);
		expect(calls.fromRegistry).toEqual([DEFAULT_MODAL_IMAGE]);
		// App resolution is a network call and must wait for the first create.
		expect(calls.fromName).toEqual([]);
	});

	test("resolves the app lazily once across creates", async () => {
		const { sandbox } = fakeSandbox();
		const { module, calls } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await client.create(createParams);
		await client.create(createParams);
		expect(calls.fromName).toEqual([
			{ name: "isolate-test", params: { createIfMissing: true } },
		]);
	});

	test("honors an explicit image reference", async () => {
		const { module, calls } = fakeSdk();
		await createModalSandboxClient(
			{ ...env, image: "oven/bun:1" },
			async () => module,
		);
		expect(calls.fromRegistry).toEqual(["oven/bun:1"]);
	});

	test("maps app resolution failures to PROVIDER_UNAVAILABLE at first create", async () => {
		const { module } = fakeSdk({ appError: new Error("app missing") });
		const client = await createModalSandboxClient(env, async () => module);
		await expect(client.create(createParams)).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
			message: "Modal app or image could not be resolved",
		});
	});
});

describe("createModalSandboxClient operations", () => {
	test("forwards create params, omits an absent allowlist, and maps exec", async () => {
		const { sandbox, calls: sdkCalls } = fakeSandbox();
		const { module, calls } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);

		const handle = await client.create(createParams);
		expect(handle).toEqual({ id: "sb-1" });
		expect(calls.create).toHaveLength(1);
		const params = calls.create[0].params as unknown as Record<string, unknown>;
		expect(params).toEqual({
			cpu: 1,
			memoryMiB: 512,
			timeoutMs: 60_000,
			idleTimeoutMs: 30_000,
			workdir: "/workspace",
			command: ["sleep", "48h"],
			blockNetwork: true,
		});
		expect(Object.hasOwn(params, "outboundDomainAllowlist")).toBe(false);
		expect(calls.create[0].app).toEqual({ name: "isolate-test" });
		expect(calls.create[0].image).toEqual({ tag: DEFAULT_MODAL_IMAGE });

		const result = await client.exec("sb-1", ["git", "--version"], {
			timeoutMs: 5_000,
			workdir: "/workspace/repo",
		});
		expect(result).toEqual({
			exitCode: 0,
			stdout: "out",
			stderr: "err",
			timedOut: false,
		});
		expect(sdkCalls.exec).toEqual([
			{
				argv: ["git", "--version"],
				params: { timeoutMs: 5_000, workdir: "/workspace/repo" },
			},
		]);
	});

	test("forwards an allowlist when present", async () => {
		const { sandbox } = fakeSandbox();
		const { module, calls } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await client.create({
			...createParams,
			blockNetwork: false,
			outboundDomainAllowlist: ["github.com"],
		});
		expect(calls.create[0].params.outboundDomainAllowlist).toEqual([
			"github.com",
		]);
		expect(calls.create[0].params.blockNetwork).toBe(false);
	});

	test("maps a wait deadline to timedOut with partial output", async () => {
		const timeout = new Error("Timeout expired");
		timeout.name = "TimeoutError";
		const { sandbox } = fakeSandbox({
			exec: async () =>
				fakeProcess({
					stdout: async () => "partial",
					stderr: async () => "",
					wait: async () => {
						throw timeout;
					},
				}),
		});
		const { module } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await client.create(createParams);
		const result = await client.exec("sb-1", ["sleep", "1"], {
			timeoutMs: 10,
			workdir: "/workspace",
		});
		expect(result).toEqual({
			exitCode: 124,
			stdout: "partial",
			stderr: "",
			timedOut: true,
		});
	});

	test("maps a non-timeout wait failure to PROVIDER_UNAVAILABLE", async () => {
		const { sandbox } = fakeSandbox({
			exec: async () =>
				fakeProcess({
					wait: async () => {
						throw new Error("container crashed");
					},
				}),
		});
		const { module } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await client.create(createParams);
		await expect(
			client.exec("sb-1", ["git"], {
				timeoutMs: 10,
				workdir: "/workspace",
			}),
		).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
			message: "Modal command failed",
		});
	});

	test("rejects an unknown handle and malformed exit codes", async () => {
		const malformed = fakeSandbox({
			exec: async () => fakeProcess({ wait: async () => 0.5 }),
		});
		const { module } = fakeSdk({ sandbox: malformed.sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await expect(
			client.exec("unknown", ["git"], {
				timeoutMs: 10,
				workdir: "/workspace",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
		await client.create(createParams);
		await expect(
			client.exec("sb-1", ["git"], {
				timeoutMs: 10,
				workdir: "/workspace",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
	});

	test.each([
		["sdk create failure", new Error("quota")],
		["sdk create protocol failure", { code: "X" }],
	] as const)("maps %s to PROVIDER_UNAVAILABLE", async (_label, error) => {
		const { module } = fakeSdk({ createError: error });
		const client = await createModalSandboxClient(env, async () => module);
		await expect(client.create(createParams)).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
			message: "Modal sandbox provisioning failed",
		});
	});

	test("rejects a sandbox without a valid id", async () => {
		const sandbox = {
			sandboxId: "",
			exec: async () => fakeProcess(),
			terminate: async () => {},
		};
		const { module } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await expect(client.create(createParams)).rejects.toMatchObject({
			code: "PROVIDER_PROTOCOL",
		});
	});
});

describe("createModalSandboxClient termination", () => {
	test("terminates once and treats unknown ids as already gone", async () => {
		const { sandbox, calls: sdkCalls } = fakeSandbox();
		const { module } = fakeSdk({ sandbox });
		const client = await createModalSandboxClient(env, async () => module);
		await client.create(createParams);
		await client.terminate("unknown");
		expect(sdkCalls.terminate).toBe(0);
		await client.terminate("sb-1");
		await client.terminate("sb-1");
		expect(sdkCalls.terminate).toBe(1);
	});

	test("tolerates NotFoundError and maps other termination failures", async () => {
		const notFound = new Error("gone");
		notFound.name = "NotFoundError";
		const tolerant = fakeSandbox({
			terminate: async () => {
				throw notFound;
			},
		});
		const first = fakeSdk({ sandbox: tolerant.sandbox });
		const tolerantClient = await createModalSandboxClient(
			env,
			async () => first.module,
		);
		await tolerantClient.create(createParams);
		await expect(tolerantClient.terminate("sb-1")).resolves.toBeUndefined();

		const failing = fakeSandbox({
			terminate: async () => {
				throw new Error("transport down");
			},
		});
		const second = fakeSdk({ sandbox: failing.sandbox });
		const failingClient = await createModalSandboxClient(
			env,
			async () => second.module,
		);
		await failingClient.create(createParams);
		await expect(failingClient.terminate("sb-1")).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
			message: "Modal sandbox termination failed",
		});
	});
});
