import { getCapabilities, Image, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { convertToPng, type Theme } from "@earendil-works/pi-coding-agent";
import type { ImagePart } from "./storage.ts";

export async function prepareImageForViewer(part: ImagePart): Promise<ImagePart> {
  if (getCapabilities().images !== "kitty" || part.mimeType === "image/png") return part;
  const converted = await convertToPng(part.data, part.mimeType);
  if (!converted) throw new Error("This original could not be converted for terminal display. Portable export retains its exact bytes.");
  return { type: "image", ...converted };
}

/** One native image, loaded only when requested, outside the transcript. */
export class OriginalImageViewer implements Component {
  private readonly image: Image;

  constructor(part: ImagePart, private readonly reference: string, private readonly theme: Theme,
    rows: number, private readonly done: () => void) {
    this.image = new Image(part.data, part.mimeType, { fallbackColor: (text) => theme.fg("muted", text) },
      { maxHeightCells: Math.max(1, rows - 5), filename: `image-${reference.replace(/[^a-zA-Z0-9_-]/g, "-")}` });
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    return [
      truncateToWidth(this.theme.fg("accent", "Original image") + this.theme.fg("dim", ` · ${this.reference}`), width),
      "",
      ...this.image.render(width),
      "",
      truncateToWidth(this.theme.fg("dim", "esc close · terminal image support required for display"), width),
    ];
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) this.done();
  }

  invalidate(): void { this.image.invalidate(); }
}
