/** Only recognize empty text and whole, short interstitial messages, never words inside articles. */
export function pageContentFailure(text: string): string | undefined {
  const normalized = text.replace(/^\s*#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
  if (!normalized) return "returned no readable content";
  if (/^(?:access denied|(?:401|403) (?:unauthorized|forbidden)|just a moment(?:\.{3}|…)?|checking your browser(?:\.{3}|…)?|please enable javascript and cookies to continue\.?|verify (?:that )?you are human[.!]?)$/i.test(normalized)) {
    return "returned an access challenge instead of page content";
  }
  return undefined;
}
