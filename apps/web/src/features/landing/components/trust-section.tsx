import { ShieldCheckIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
	pageContainer,
	sectionLede,
	sectionPadding,
	sectionTitle,
} from "../styles";
import { FrameDots } from "./frame";
import { ConnectorCall, DeviceBoundary } from "./illustrations/device-boundary";
import { Reveal } from "./reveal";

const LEGEND = [
	{
		title: "Vendor keychain",
		copy: "Holds the provider key. It never leaves the device.",
	},
	{
		title: "Device daemon",
		copy: "Claims typed calls and executes them locally.",
	},
	{
		title: "Control plane",
		copy: "Stores a device token hash and connector metadata. No vendor key.",
	},
] as const;

function TrustDiagram() {
	return (
		<figure className="wf-figure wf-figure-trust">
			<figcaption className="sr-only">
				Credentials stay on the device. The vendor keychain and the device
				daemon sit inside the local credential boundary; the Isolate control
				plane stores only a token hash and connector metadata.
			</figcaption>

			<DeviceBoundary />
			<div className="wf-figure-inset">
				<ConnectorCall />
			</div>

			<dl className="mt-10 grid gap-6 border-t border-line-subtle pt-8 sm:grid-cols-3 sm:gap-8">
				{LEGEND.map((item) => (
					<div key={item.title}>
						<dt className="text-[14px] font-medium text-ink">{item.title}</dt>
						<dd className="mt-1.5 text-[13px] leading-5 text-ink-muted">
							{item.copy}
						</dd>
					</div>
				))}
			</dl>

			<div className="mt-8 flex items-start gap-2.5 border-t border-line-subtle pt-4">
				<ShieldCheckIcon size={15} className="mt-0.5 shrink-0 text-brand" />
				<p className="text-[12px] leading-5 text-ink-muted">
					No vendor secret is stored server-side, in logs, or in the sandbox.
				</p>
			</div>
		</figure>
	);
}

export function TrustSection() {
	return (
		<section id="trust" className="relative scroll-mt-20 bg-canvas">
			<FrameDots />
			<div className={cn(pageContainer, sectionPadding)}>
				<Reveal className="max-w-[64ch]">
					<h2 className={sectionTitle}>
						Your credentials stay on your device.
					</h2>
					<p className={sectionLede}>
						Connectors execute where the keys already live. The control plane
						records only a device token hash and connector metadata, so a server
						compromise cannot reach a vendor account.
					</p>
				</Reveal>

				<Reveal className="mt-14" delay={80}>
					<TrustDiagram />
				</Reveal>
			</div>
		</section>
	);
}
