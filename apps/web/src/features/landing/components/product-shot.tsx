import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One product-view frame for the landing hero. The inner aspect ratio is fixed
 * by the caller so a later capture with the same crop drops in without moving
 * the layout. The lower third blurs and fades so the bottom of the console is
 * never shown.
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
	/** Progressive blur and fade from the lower third of the frame. */
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
							className="pointer-events-none absolute inset-x-0 bottom-0 h-[38%]"
						>
							<div className="absolute inset-x-0 bottom-0 h-full backdrop-blur-[2px] [mask-image:linear-gradient(to_top,black_14%,transparent_100%)]" />
							<div className="absolute inset-x-0 bottom-0 h-[72%] backdrop-blur-[5px] [mask-image:linear-gradient(to_top,black_6%,transparent_96%)]" />
							<div className="absolute inset-x-0 bottom-0 h-[44%] backdrop-blur-[10px] [mask-image:linear-gradient(to_top,black_0%,transparent_88%)]" />
							<div className="absolute inset-x-0 bottom-0 h-[18%] bg-gradient-to-t from-canvas via-canvas/70 to-transparent" />
						</div>
					) : null}
				</div>
			</ShotFrame>
		</figure>
	);
}
