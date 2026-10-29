import { expect, test } from "bun:test";
import type { CompiledWorkflowPlan, WorkflowRejectionIssue } from "../schema";
import { createInMemoryWorkflowCompilationRepositories } from "../testing";
import {
	compiledPlan,
	issue,
	pin,
	planRow,
	recordingSql,
} from "../testing/workflow-compilation-fixtures";
import { PostgresCompiledPlanRepository } from "./compiled-plan-repository";
import {
	serializeWorkflowJson,
	validateCompiledPlan,
	validateRejectionIssues,
} from "./workflow-compilation";
import { PostgresWorkflowRejectionRepository } from "./workflow-rejection-repository";

const source = "private-workflow-source";

async function rejectedByBoth(
	kind: "plan" | "issues",
	payload: unknown,
): Promise<void> {
	const { sql, calls } = recordingSql([]);
	const stores = [
		createInMemoryWorkflowCompilationRepositories({ versions: [pin] }),
		{
			compiledPlans: new PostgresCompiledPlanRepository(sql),
			rejections: new PostgresWorkflowRejectionRepository(sql),
		},
	];
	const messages: string[] = [];
	for (const store of stores) {
		const operation =
			kind === "plan"
				? store.compiledPlans.save({
						...pin,
						plan: payload as CompiledWorkflowPlan,
					})
				: store.rejections.record({
						...pin,
						issues: payload as WorkflowRejectionIssue[],
					});
		const error: unknown = await operation.then(
			() => null,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error))
			throw new Error("expected payload rejection");
		expect(error.message).toContain("workflow payload");
		expect(error.message).not.toContain(source);
		messages.push(error.message);
	}
	expect(messages[0]).toBe(messages[1]);
	expect(calls).toHaveLength(0);
}

test("plan.steps.toJSON cannot replace validated steps with a string", async () => {
	const plan = compiledPlan();
	let calls = 0;
	Object.defineProperty(plan.steps, "toJSON", {
		enumerable: true,
		value: () => {
			calls++;
			return source;
		},
	});
	await rejectedByBoth("plan", plan);
	expect(calls).toBe(0);
});

test("issues.toJSON cannot replace validated rejection history with an empty array", async () => {
	const issues = [{ ...issue }];
	let calls = 0;
	Object.defineProperty(issues, "toJSON", {
		value: () => {
			calls++;
			return [];
		},
	});
	await rejectedByBoth("issues", issues);
	expect(calls).toBe(0);
});

for (const kind of ["plan", "issues"] as const) {
	for (const enumerable of [false, true]) {
		test(`${kind}: object toJSON hooks are rejected, enumerable=${enumerable}`, async () => {
			const payload = kind === "plan" ? compiledPlan() : [{ ...issue }];
			const object = Array.isArray(payload)
				? payload[0]
				: payload.steps[0].config;
			let calls = 0;
			Object.defineProperty(object, "toJSON", {
				enumerable,
				value: () => {
					calls++;
					throw new Error(source);
				},
			});
			await rejectedByBoth(kind, payload);
			expect(calls).toBe(0);
		});
		test(`${kind}: validation never invokes field getters, enumerable=${enumerable}`, async () => {
			const payload = kind === "plan" ? compiledPlan() : [{ ...issue }];
			const object = Array.isArray(payload) ? payload[0] : payload;
			const key = kind === "plan" ? "planId" : "message";
			let calls = 0;
			Object.defineProperty(object, key, {
				enumerable,
				get: () => {
					calls++;
					throw new Error(source);
				},
			});
			await rejectedByBoth(kind, payload);
			expect(calls).toBe(0);
		});
	}
	test(`${kind}: arrays reject custom data properties and hidden accessors`, async () => {
		for (const accessor of [false, true]) {
			const payload = kind === "plan" ? compiledPlan() : [{ ...issue }];
			const array = Array.isArray(payload) ? payload : payload.steps;
			let calls = 0;
			Object.defineProperty(
				array,
				source,
				accessor
					? {
							get: () => {
								calls++;
								throw new Error(source);
							},
						}
					: { enumerable: true, value: "ignored by JSON.stringify" },
			);
			await rejectedByBoth(kind, payload);
			expect(calls).toBe(0);
		}
	});
}

const incompatible = [
	["NUL", String.fromCharCode(0)],
	["high surrogate", String.fromCharCode(0xd800)],
	["low surrogate", String.fromCharCode(0xdc00)],
	["high before ASCII", String.fromCharCode(0xdbff, 0x41)],
	["reversed pair", String.fromCharCode(0xdfff, 0xd800)],
] as const;
for (const [label, unicode] of incompatible) {
	for (const kind of ["plan", "issues"] as const) {
		for (const location of ["key", "value"] as const) {
			test(`${kind}: PostgreSQL JSONB rejects ${label} in a ${location} without leaking source`, async () => {
				const payload = kind === "plan" ? compiledPlan() : [{ ...issue }];
				const object = Array.isArray(payload)
					? payload[0]
					: payload.steps[0].config;
				Object.defineProperty(
					object,
					location === "key" ? `${source}${unicode}` : source,
					{
						enumerable: true,
						value: location === "value" ? `${source}${unicode}` : "safe",
					},
				);
				await rejectedByBoth(kind, payload);
			});
		}
	}
}

test("JSON copying rejects sparse arrays, symbol properties and hidden object data", () => {
	for (const value of [
		Array(1),
		{ [Symbol("private")]: true },
		Object.defineProperty({}, source, { value: "hidden" }),
	]) {
		expect(() => serializeWorkflowJson(value)).toThrow("workflow payload");
	}
});

test("PostgreSQL and fake persist identical valid Unicode snapshots with permissive dot-free IDs", async () => {
	const pair = String.fromCharCode(0xd83d, 0xde80);
	const id = `node /:[]-${String.fromCharCode(0x3a9)}${pair}`;
	const plan = compiledPlan();
	plan.planId = `plan /:[]-${pair}`;
	plan.steps[0].nodeId = id;
	plan.entryNodeIds = [id];
	const jsonObject = Object.create(null) as Record<string, unknown>;
	jsonObject[`key${pair}`] = `value${pair}`;
	jsonObject.__proto__ = `data${pair}`;
	jsonObject.toJSON = "a data string, not a serialization hook";
	Object.assign(plan.steps[0].config, { extra: jsonObject });
	const issues = [
		{ ...issue, message: `message${pair}`, [`key${pair}`]: `value${pair}` },
	];
	const expectedPlan = JSON.parse(serializeWorkflowJson(plan));
	const expectedIssues = JSON.parse(serializeWorkflowJson(issues));
	const { plan: _plan, ...base } = planRow(expectedPlan);
	const { sql, calls } = recordingSql([
		[{ ...base, plan: JSON.stringify(expectedPlan) }],
		[{ ...base, issues: JSON.stringify(expectedIssues) }],
	]);
	const stores = [
		createInMemoryWorkflowCompilationRepositories({ versions: [pin] }),
		{
			compiledPlans: new PostgresCompiledPlanRepository(sql),
			rejections: new PostgresWorkflowRejectionRepository(sql),
		},
	];
	for (const store of stores) {
		const saved = await store.compiledPlans.save({ ...pin, plan });
		const recorded = await store.rejections.record({ ...pin, issues });
		if (!saved.ok || !recorded.ok)
			throw new Error("valid Unicode fixture was rejected");
		expect(saved.plan.plan).toEqual(expectedPlan);
		expect(saved.plan.plan.steps[0].nodeId).toBe(id);
		expect(recorded.rejection.issues).toEqual(expectedIssues);
	}
	expect(calls[0].params[3]).toBe(JSON.stringify(expectedPlan));
	expect(calls[1].params[3]).toBe(JSON.stringify(expectedIssues));
});

for (const kind of ["plan", "issues"] as const) {
	test(`${kind}: array index getters cannot execute while copying`, async () => {
		const payload = kind === "plan" ? compiledPlan() : [{ ...issue }];
		const array = Array.isArray(payload) ? payload : payload.steps;
		let calls = 0;
		Object.defineProperty(array, "0", {
			enumerable: true,
			get: () => {
				calls++;
				throw new Error(source);
			},
		});
		await rejectedByBoth(kind, payload);
		expect(calls).toBe(0);
	});

	test(`${kind}: nonenumerable toJSON getters and setter-only properties are rejected`, async () => {
		for (const setter of [false, true]) {
			const payload = kind === "plan" ? compiledPlan() : [{ ...issue }];
			const object = Array.isArray(payload) ? payload[0] : payload;
			let calls = 0;
			Object.defineProperty(
				object,
				"toJSON",
				setter
					? {
							set: () => {
								calls++;
								throw new Error(source);
							},
						}
					: {
							get: () => {
								calls++;
								throw new Error(source);
							},
						},
			);
			await rejectedByBoth(kind, payload);
			expect(calls).toBe(0);
		}
	});

	test(`${kind}: inherited serialization hooks and proxy traps are rejected without execution`, async () => {
		let calls = 0;
		const prototype = Object.create(null);
		Object.defineProperty(prototype, "toJSON", {
			get: () => {
				calls++;
				throw new Error(source);
			},
		});
		const inherited = Object.setPrototypeOf(
			kind === "plan" ? compiledPlan() : [{ ...issue }],
			prototype,
		);
		await rejectedByBoth(kind, inherited);
		const proxy = new Proxy(kind === "plan" ? compiledPlan() : [{ ...issue }], {
			getPrototypeOf: () => {
				calls++;
				throw new Error(source);
			},
			ownKeys: () => {
				calls++;
				throw new Error(source);
			},
		});
		await rejectedByBoth(kind, proxy);
		expect(calls).toBe(0);
	});
}

test("compilation envelope getters are rejected before source properties are read", () => {
	let calls = 0;
	const input = { ...pin };
	for (const key of ["plan", "issues", "workflowVersion"]) {
		Object.defineProperty(input, key, {
			configurable: true,
			get: () => {
				calls++;
				throw new Error(source);
			},
		});
	}
	expect(() =>
		validateCompiledPlan(input as Parameters<typeof validateCompiledPlan>[0]),
	).toThrow("workflow payload");
	expect(() =>
		validateRejectionIssues(
			input as Parameters<typeof validateRejectionIssues>[0],
		),
	).toThrow("workflow payload");
	expect(calls).toBe(0);
});

test("surrogate-pair boundaries survive unchanged in JSON values and keys", () => {
	for (const value of [
		String.fromCharCode(0xd800, 0xdc00),
		String.fromCharCode(0xdbff, 0xdfff),
		String.fromCharCode(0xfffd),
	]) {
		const decoded = JSON.parse(serializeWorkflowJson({ [value]: [value] }));
		expect(Object.keys(decoded)).toEqual([value]);
		expect(decoded[value]).toEqual([value]);
	}
});
