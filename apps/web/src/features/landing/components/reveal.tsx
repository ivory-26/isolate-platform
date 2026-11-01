import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Observes an element once. Returns true the first time it enters the
 * viewport and stays true afterwards. Falls back to visible when
 * IntersectionObserver is unavailable.
 */
export function useInView<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [inView, setInView] = useState(false);

	useEffect(() => {
		const node = ref.current;
		if (!node) return;

		if (typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setInView(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
		);

		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	return { ref, inView };
}

/** Adds one short transform/opacity reveal when the block scrolls into view. */
export function Reveal({
	children,
	className,
	delay = 0,
}: {
	children: ReactNode;
	className?: string;
	delay?: number;
}) {
	const { ref, inView } = useInView<HTMLDivElement>();

	return (
		<div
			ref={ref}
			className={cn("landing-reveal", inView && "is-in", className)}
			style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
		>
			{children}
		</div>
	);
}
