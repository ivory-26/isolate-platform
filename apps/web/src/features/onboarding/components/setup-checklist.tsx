import { Link } from "@tanstack/react-router";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { ArrowRightIcon, CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SetupState } from "../contracts";
import {
	buildSetupSteps,
	completedStepCount,
	type SetupStep,
} from "../setup-steps";

/**
 * The setup checklist. Reused by the wizard and by Home until every step is
 * complete. One primary action per incomplete step; completed steps are links
 * back to their surface, not fake controls.
 */
export function SetupChecklist({
	state,
	title = "Setup",
	description = "Make Isolate event-first: GitHub, a relay, one source and a default trigger.",
}: {
	state: SetupState;
	title?: string;
	description?: string;
}) {
	const steps = buildSetupSteps(state);
	const completed = completedStepCount(state);

	return (
		<ConsoleSection
			id="setup-checklist"
			title={
				<span className="flex items-center gap-2">
					{title}
					<span className="font-mono text-[11px] text-ink-muted tabular-nums">
						{completed}/{steps.length}
					</span>
				</span>
			}
			description={description}
		>
			{state.complete ? (
				<ConsoleNote role="status" className="mb-3">
					Setup is complete. Events from a connected source can create tasks.
				</ConsoleNote>
			) : null}
			<ol className="divide-y divide-line-subtle border-y border-line-subtle">
				{steps.map((step, index) => (
					<ChecklistRow
						key={step.id}
						step={step}
						index={index}
						state={state}
						current={!step.complete && isCurrent(steps, step.id)}
					/>
				))}
			</ol>
		</ConsoleSection>
	);
}

function isCurrent(steps: readonly SetupStep[], id: SetupStep["id"]): boolean {
	const firstIncomplete = steps.find((step) => !step.complete);
	return firstIncomplete?.id === id;
}

function ChecklistRow({
	step,
	index,
	state,
	current,
}: {
	step: SetupStep;
	index: number;
	state: SetupState;
	current: boolean;
}) {
	return (
		<li
			className={cn(
				"flex flex-col gap-3 py-4 pl-3 sm:flex-row sm:items-center sm:justify-between",
				current && "border-l-2 border-brand",
			)}
		>
			<div className="flex min-w-0 items-start gap-3">
				<span
					aria-hidden="true"
					className={cn(
						"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
						step.complete
							? "border-success/40 text-success"
							: current
								? "border-brand/50 text-brand"
								: "border-line text-ink-muted",
					)}
				>
					{step.complete ? <CheckIcon size={12} /> : index + 1}
				</span>
				<div className="min-w-0 space-y-1">
					<p className="text-sm font-medium text-ink">
						{step.title}
						<span className="sr-only">
							{step.complete ? " — complete" : current ? " — next step" : ""}
						</span>
					</p>
					<p className="max-w-[62ch] text-xs leading-5 text-ink-muted">
						{step.description}
					</p>
				</div>
			</div>
			<div className="shrink-0 pl-8 sm:pl-0">
				{step.complete ? (
					<span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
						<CheckIcon size={14} className="text-success" />
						Done
					</span>
				) : (
					<SetupAction step={step} state={state} />
				)}
			</div>
		</li>
	);
}

function SetupAction({ step, state }: { step: SetupStep; state: SetupState }) {
	if (step.id === "github" && !state.githubConnected) {
		return (
			<Button asChild size="sm">
				<a href="/api/github/install">
					{step.actionLabel}
					<ArrowRightIcon />
				</a>
			</Button>
		);
	}
	if (step.id === "github") {
		return (
			<Button asChild size="sm" variant="outline">
				<Link to="/repositories" search={{ q: "" }}>
					{step.actionLabel}
					<ArrowRightIcon />
				</Link>
			</Button>
		);
	}
	if (step.id === "relay") {
		return (
			<Button asChild size="sm" variant="outline">
				<Link to="/integrations" search={{ tab: "relays" }}>
					{step.actionLabel}
					<ArrowRightIcon />
				</Link>
			</Button>
		);
	}
	if (step.id === "source") {
		return (
			<Button asChild size="sm" variant="outline">
				<Link to="/integrations" search={{ tab: "catalog" }}>
					{step.actionLabel}
					<ArrowRightIcon />
				</Link>
			</Button>
		);
	}
	return (
		<Button asChild size="sm" variant="outline">
			<Link to="/onboarding">
				{step.actionLabel}
				<ArrowRightIcon />
			</Link>
		</Button>
	);
}
