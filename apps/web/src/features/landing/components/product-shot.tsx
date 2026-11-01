import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One product-view frame for the whole page. The inner aspect ratio is fixed
 * by the caller, so a later screenshot recapture with the same crop drops in
 * without moving the layout.
 */
export function ShotFrame({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.45)]",
				className,
			)}
		>
			<div className="overflow-hidden rounded-[10px] border border-line-subtle bg-canvas">
				{children}
			</div>
		</div>
	);
}

export function ProductShot({
	src,
	alt,
	width,
	height,
	aspect,
	eager = false,
	align = "left",
	fadeBottom = false,
	className,
}: {
	src: string;
	alt: string;
	width: number;
	height: number;
	/** Optional fixed display crop, e.g. trimming dead space from a capture. */
	aspect?: string;
	eager?: boolean;
	align?: "left" | "center";
	/** Progressive backdrop blur where the console meets the page. */
	fadeBottom?: boolean;
	className?: string;
}) {
	return (
		<figure className={className}>
			<ShotFrame>
				<div
					className="relative"
					style={{ aspectRatio: aspect ?? `${width} / ${height}` }}
				>
					<img
						src={src}
						width={width}
						height={height}
						alt={alt}
						loading={eager ? "eager" : "lazy"}
						decoding="async"
						className="absolute inset-0 size-full object-cover object-top"
					/>
					{fadeBottom ? (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-0 bottom-0 h-28"
						>
							<div className="absolute inset-x-0 bottom-0 h-28 backdrop-blur-[2px] [mask-image:linear-gradient(to_top,black_5%,transparent_100%)]" />
							<div className="absolute inset-x-0 bottom-0 h-20 backdrop-blur-[5px] [mask-image:linear-gradient(to_top,black_0%,transparent_92%)]" />
							<div className="absolute inset-x-0 bottom-0 h-12 backdrop-blur-[10px] [mask-image:linear-gradient(to_top,black_0%,transparent_85%)]" />
						</div>
					) : null}
				</div>
			</ShotFrame>
			<figcaption
				className={cn(
					"mt-3 font-mono text-[11px] leading-5 text-ink-muted",
					align === "center" && "text-center",
				)}
			>
				Illustrative product view · synthetic data
			</figcaption>
		</figure>
	);
}
