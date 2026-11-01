import { runEvents } from "../content";
import { ShotFrame } from "./product-shot";

/** The third capability view: the durable event record, in the same frame. */
export function EventTrace() {
	return (
		<figure>
			<ShotFrame>
				<div className="flex items-center justify-between gap-4 border-b border-line-subtle px-4 py-3">
					<span className="font-mono text-[10px] text-ink-muted">
						run events
					</span>
					<span className="font-mono text-[10px] text-ink-muted">
						2a6d6902 · newest last
					</span>
				</div>
				<ul className="divide-y divide-line-subtle">
					{runEvents.map((event) => (
						<li
							key={event.event}
							className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 px-4 py-3"
						>
							<span className="font-mono text-[12px] text-ink-secondary">
								{event.event}
							</span>
							<span className="tabular font-mono text-[11px] text-ink-muted">
								{event.offset}
							</span>
							<span className="col-span-2 mt-1 font-mono text-[11px] leading-5 text-ink-muted">
								{event.detail}
							</span>
						</li>
					))}
				</ul>
			</ShotFrame>
			<figcaption className="mt-3 font-mono text-[11px] leading-5 text-ink-muted">
				Illustrative event log · synthetic data
			</figcaption>
		</figure>
	);
}
