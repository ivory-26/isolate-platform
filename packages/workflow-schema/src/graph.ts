/**
 * Deterministic graph helpers shared by validation and compilation.
 * All inputs are arrays indexed by the order nodes appear in the definition,
 * which keeps every derived ordering stable.
 */

/** Builds node→edge-index adjacency from edges referenced by node index. */
export function edgeAdjacency(
	nodeCount: number,
	edges: Array<{ from: number; to: number }>,
): number[][] {
	const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
	for (let i = 0; i < edges.length; i++) {
		const e = edges[i];
		adjacency[e.from].push(i);
	}
	return adjacency;
}

/** Builds node→node adjacency (deduplicated) for cycle analysis. */
export function nodeAdjacency(
	nodeCount: number,
	edges: Array<{ from: number; to: number }>,
): number[][] {
	const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
	for (const e of edges) {
		// Parallel edges do not change SCC structure; dedupe to keep analyses O(E).
		if (!adjacency[e.from].includes(e.to)) adjacency[e.from].push(e.to);
	}
	return adjacency;
}

/**
 * Iterative Tarjan strongly-connected components. The caller seeds the DFS
 * stack in node definition order, so component emission order is a pure
 * function of the definition — required for deterministic compilation.
 */
export function tarjanComponents(
	nodeCount: number,
	adjacency: number[][],
): number[][] {
	const index = new Int32Array(nodeCount).fill(-1);
	const low = new Int32Array(nodeCount);
	const onStack = new Uint8Array(nodeCount);
	const stack: number[] = [];
	const components: number[][] = [];
	let counter = 0;

	const frames: Array<{ v: number; i: number }> = [];
	for (let seed = 0; seed < nodeCount; seed++) {
		if (index[seed] !== -1) continue;
		frames.push({ v: seed, i: 0 });
		while (frames.length > 0) {
			const frame = frames[frames.length - 1];
			const v = frame.v;
			if (frame.i === 0) {
				index[v] = counter;
				low[v] = counter;
				counter++;
				stack.push(v);
				onStack[v] = 1;
			}
			if (frame.i < adjacency[v].length) {
				const w = adjacency[v][frame.i++];
				if (index[w] === -1) {
					frames.push({ v: w, i: 0 });
				} else if (onStack[w] === 1) {
					if (index[w] < low[v]) low[v] = index[w];
				}
			} else {
				frames.pop();
				if (frames.length > 0) {
					const parent = frames[frames.length - 1].v;
					if (low[v] < low[parent]) low[parent] = low[v];
				}
				if (low[v] === index[v]) {
					const component: number[] = [];
					for (;;) {
						const w = stack.pop() as number;
						onStack[w] = 0;
						component.push(w);
						if (w === v) break;
					}
					components.push(component);
				}
			}
		}
	}
	return components;
}

/** Node indices reachable from the given roots following edges forward. */
export function reachableFrom(
	nodeCount: number,
	adjacency: number[][],
	roots: number[],
): Uint8Array {
	const seen = new Uint8Array(nodeCount);
	const queue: number[] = [];
	for (const root of roots) {
		if (seen[root] === 0) {
			seen[root] = 1;
			queue.push(root);
		}
	}
	for (let head = 0; head < queue.length; head++) {
		const v = queue[head];
		for (const w of adjacency[v]) {
			if (seen[w] === 0) {
				seen[w] = 1;
				queue.push(w);
			}
		}
	}
	return seen;
}
