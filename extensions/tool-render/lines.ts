import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { closeDanglingLink, getHyperlinkMode } from "../../lib/links.ts";
import { syntaxRevision } from "../../lib/syntax.ts";

/** Truncation can drop an OSC 8 terminator; close it before rendering the next line. */
export const fit = (s: string, width: number): string =>
	closeDanglingLink(visibleWidth(s) <= width ? s : truncateToWidth(s, width, "…"));

/** Process-wide counters for diagnostics and benchmarks. */
export const renderCacheStats = { builds: 0, hits: 0 };

/** Inputs shared by every card that can change without recreating it. */
export const baseRevision = (): string => `${getHyperlinkMode()}:${syntaxRevision()}`;

const MAX_WIDTHS = 4;

export interface LinesOptions {
	/** Running or streaming cards rebuild every frame, so live state stays current. */
	volatile?: boolean;
	/** External state the rows depend on; a changed value drops cached rows. */
	revision?: () => string;
}

/**
 * Fit each render to the current width and fall back to plain text on errors.
 * Pi recreates renderer components when arguments, results, expansion or theme
 * change, so a settled card's rows depend only on width and `revision`: they are
 * built once per width and repainted byte-identically.
 */
export class Lines implements Component {
	private readonly cache = new Map<number, string[]>();
	private cachedRevision: string | undefined;

	constructor(
		private readonly build: (width: number) => string[],
		private readonly fallback: string,
		private readonly options: LinesOptions = {},
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const w = Math.max(1, width);
		const cacheable = !this.options.volatile;
		if (cacheable) {
			const revision = (this.options.revision ?? baseRevision)();
			if (revision !== this.cachedRevision) {
				this.cache.clear();
				this.cachedRevision = revision;
			}
			const hit = this.cache.get(w);
			if (hit) {
				renderCacheStats.hits++;
				return hit.slice();
			}
		}
		renderCacheStats.builds++;
		let lines: string[];
		try {
			lines = this.build(w).map((l) => fit(l, w));
		} catch {
			return [fit(this.fallback, w)];
		}
		if (cacheable) {
			if (this.cache.size >= MAX_WIDTHS) this.cache.delete(this.cache.keys().next().value!);
			this.cache.set(w, lines);
			return lines.slice();
		}
		return lines;
	}

	invalidate(): void {
		this.cache.clear();
		this.cachedRevision = undefined;
	}
}
