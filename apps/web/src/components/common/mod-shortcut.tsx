import { useEffect, useState } from "react";
import { Kbd } from "./kbd";

/** Platform-aware modifier hint; the behavior itself accepts Ctrl or Cmd. */
export function ModShortcut({ keyName = "K" }: { keyName?: string }) {
	const [modifier, setModifier] = useState("Ctrl");
	useEffect(() => {
		if (/Mac|iPhone|iPad|iPod/.test(navigator.platform)) setModifier("⌘");
	}, []);
	return (
		<span className="flex items-center gap-0.5">
			<Kbd>{modifier}</Kbd>
			<Kbd>{keyName}</Kbd>
		</span>
	);
}
