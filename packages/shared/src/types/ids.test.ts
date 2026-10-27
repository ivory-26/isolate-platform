import { describe, expect, test } from "bun:test";
import { asTaskId, asUserId, newId, type TaskId, type UserId } from "./ids";

describe("branded ids", () => {
	const UUID_PATTERN =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

	test("newId prefixes a uuid v4 string", () => {
		const id = newId("task");
		expect(id.startsWith("task_")).toBe(true);
		expect(id.slice("task_".length)).toMatch(UUID_PATTERN);
	});

	test("newId is unique across calls", () => {
		expect(newId("run")).not.toBe(newId("run"));
	});

	test("cast helpers keep the runtime value unchanged", () => {
		const taskId: TaskId = asTaskId("task_abc");
		const userId: UserId = asUserId("user_abc");
		expect(taskId as string).toBe("task_abc");
		expect(userId as string).toBe("user_abc");
	});

	test("distinct brands are not assignable in type space (compile gate)", () => {
		const userId = asUserId("user_mismatch");
		// @ts-expect-error different brands must not be interchangeable
		const swapped: TaskId = userId;
		expect(swapped as string).toBe("user_mismatch");

		const taskId = asTaskId("task_mismatch");
		// @ts-expect-error and back in the other direction
		const swappedBack: UserId = taskId;
		expect(swappedBack as string).toBe("task_mismatch");
	});
});
