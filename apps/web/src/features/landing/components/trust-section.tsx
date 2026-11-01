import { ArrowRightIcon, ShieldCheckIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
	pageContainer,
	sectionLede,
	sectionPadding,
	sectionTitle,
} from "../styles";
import { FrameDots } from "./frame";
import { Reveal } from "./reveal";

function TrustDiagram() {
	return (
		<figure className="overflow-hidden rounded-2xl border border-line-subtle bg-surface">
			<figcaption className="sr-only">
				Credentials stay on the device. The vendor keychain and the device
				daemon sit inside the local credential boundary; the Isolate control
				plane stores only a token hash and connector metadata.
			</figcaption>

			<div className="grid lg:grid-cols-[1.5fr_1fr]">
				<div className="flex p-4 sm:p-6">
					<div className="flex h-full w-full flex-col rounded-xl border border-dashed border-line-strong p-4 sm:p-5">
						<p className="font-mono text-[10px] leading-4 text-ink-muted">
							your device · credentials stay here
						</p>
						<div className="mt-5 mb-6 grid gap-5 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
							<div>
								<p className="text-[14px] font-medium text-ink">
									Vendor keychain
								</p>
								<p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
									Holds the provider key. It never leaves the device.
								</p>
							</div>
							<ArrowRightIcon
								size={14}
								className="mt-1 hidden text-ink-muted sm:block"
							/>
							<div>
								<p className="text-[14px] font-medium text-ink">
									Device daemon
								</p>
								<p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
									Claims typed calls and executes them locally.
								</p>
							</div>
						</div>
						<p className="mt-auto border-t border-dashed border-line-strong/70 pt-3 font-mono text-[10px] leading-4 text-ink-muted">
							key material never leaves this boundary
						</p>
					</div>
				</div>

				<div className="border-t border-line-subtle p-4 sm:p-6 lg:border-t-0 lg:border-l lg:pt-11">
					<p className="font-mono text-[10px] leading-4 text-ink-muted">
						isolate control plane
					</p>
					<p className="mt-5 text-[14px] font-medium text-ink">Control plane</p>
					<p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
						Stores a device token hash and connector metadata. No vendor key.
					</p>
					<div className="mt-5 border-t border-line-subtle pt-4 font-mono text-[10px] leading-6 text-ink-muted">
						<p>token_hash</p>
						<p>connector_id</p>
						<p>scopes</p>
					</div>
				</div>
			</div>

			<div className="flex items-start gap-2.5 border-t border-line-subtle px-4 py-4 sm:px-6">
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
