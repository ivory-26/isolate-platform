import { ConsoleNote } from "@/components/console/note";
import { Label } from "@/components/ui/label";
import {
	type PairingRelay,
	relayChoices,
	relayOptionLabel,
	relaySelectionHint,
} from "../relay-selection";

const SELECT_CLASS =
	"h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * Relay field for the pairing form. The value is controlled by the parent so a
 * manual choice survives polling and refetches; only the option order and the
 * default come from heartbeat metadata. `nowMs` is null until the client has
 * measured "now", so the server render asserts nothing about freshness.
 */
export function RelayPicker({
	relays,
	selectedId,
	onSelect,
	nowMs,
}: {
	relays: readonly PairingRelay[];
	selectedId: string | null;
	onSelect: (relayId: string) => void;
	nowMs: number | null;
}) {
	const choices = relayChoices(relays, nowMs);
	const hint = relaySelectionHint({ choices, selectedId, nowMs });
	return (
		<div className="space-y-1.5">
			<Label htmlFor="pairing-relay">Relay</Label>
			<select
				id="pairing-relay"
				name="relayId"
				className={SELECT_CLASS}
				required
				value={selectedId ?? choices[0]?.relay.id ?? ""}
				onChange={(event) => onSelect(event.currentTarget.value)}
			>
				{choices.map((choice) => (
					<option key={choice.relay.id} value={choice.relay.id}>
						{relayOptionLabel(choice, nowMs)}
					</option>
				))}
			</select>
			{hint === null ? null : (
				<ConsoleNote tone="warning" role="status">
					{hint}
				</ConsoleNote>
			)}
		</div>
	);
}
