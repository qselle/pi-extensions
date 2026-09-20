import * as CodingAgent from "@earendil-works/pi-coding-agent";

/** Let Pi choose its native backend or terminal fallback and report failures. */
export async function copyText(
  text: string,
  copy: (text: string) => Promise<void> = CodingAgent.copyToClipboard,
): Promise<boolean> {
  try {
    await copy(text);
    return true;
  } catch {
    return false;
  }
}
