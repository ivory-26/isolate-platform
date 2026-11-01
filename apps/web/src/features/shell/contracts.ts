import { z } from "zod";

export const shellSummarySchema = z.strictObject({
	pendingApprovals: z.number().int().min(0),
	activeTasks: z.number().int().min(0),
});

export type ShellSummary = z.infer<typeof shellSummarySchema>;
