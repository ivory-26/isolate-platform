import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SubmitIcon } from "@/components/icons";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	RUNS_SEARCH_DEFAULTS,
	type RunsListPage,
} from "@/features/runs/contracts";
import { runsListOptions } from "@/features/runs/queries";
import { commandRunItems, commandRunQuery } from "./command-runs";
import { NAV_GROUPS, type NavPath } from "./nav";

type CommandTarget = NavPath | "/submit";

export function CommandMenu({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const runQuery = commandRunQuery(query);
	// The palette only pays for a run read while it is open and the user has
	// typed enough to narrow the tenant's history.
	const runsQuery = useQuery({
		...runsListOptions({ ...RUNS_SEARCH_DEFAULTS, q: runQuery }),
		enabled: open && runQuery.length > 0,
	});
	const runs: RunsListPage["rows"] =
		runsQuery.data?.ok === true ? runsQuery.data.value.rows : [];
	const runItems = commandRunItems(runs);

	const run = (to: CommandTarget) => {
		onOpenChange(false);
		void navigate({ to });
	};
	const openRun = (taskId: string) => {
		onOpenChange(false);
		void navigate({ to: "/runs/$taskId", params: { taskId } });
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setQuery("");
				onOpenChange(next);
			}}
		>
			<Command>
				<CommandInput
					placeholder="Search pages, actions and runs…"
					value={query}
					onValueChange={setQuery}
				/>
				<CommandList>
					<CommandEmpty>No matching page, action or run.</CommandEmpty>
					{runItems.length > 0 ? (
						<CommandGroup heading="Runs">
							{runItems.map((item) => (
								<CommandItem
									key={item.taskId}
									value={item.value}
									onSelect={() => openRun(item.taskId)}
								>
									<span className="font-mono text-xs">{item.label}</span>
									<span className="ml-auto truncate text-xs text-ink-muted">
										{item.hint}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
					<CommandGroup heading="Actions">
						<CommandItem
							value="submit new task create"
							onSelect={() => run("/submit")}
						>
							<SubmitIcon />
							Submit a task
						</CommandItem>
					</CommandGroup>
					{NAV_GROUPS.map((group) => (
						<CommandGroup key={group.label} heading={group.label}>
							{group.items.map((item) => {
								const Glyph = item.icon;
								return (
									<CommandItem
										key={item.to}
										value={`${group.label} ${item.label}`}
										onSelect={() => run(item.to)}
									>
										<Glyph size={16} />
										{item.label}
									</CommandItem>
								);
							})}
						</CommandGroup>
					))}
				</CommandList>
			</Command>
		</CommandDialog>
	);
}
