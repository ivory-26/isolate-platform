import { useNavigate } from "@tanstack/react-router";
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
	const run = (to: CommandTarget) => {
		onOpenChange(false);
		void navigate({ to });
	};

	return (
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			<Command>
				<CommandInput placeholder="Search pages and actions…" />
				<CommandList>
					<CommandEmpty>No matching page or action.</CommandEmpty>
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
