/** Interstitials are short; long pages with such a line are treated as articles. */
const CHALLENGE_PAGE_CHARS = 10_000;
const CHALLENGE_HEAD_CHARS = 2_000;
/** Lines that open bot, CAPTCHA or JavaScript walls; matched at line start only, never mid-sentence. */
const CHALLENGE_LINE = /^(?:checking (?:if the site connection is secure|your browser)|verify(?:ing)? (?:that )?you(?: are|'re|’re) (?:a )?(?:human|not a robot)|performing security verification|please complete the security check|enable javascript and cookies to continue|please (?:enable|turn on) javascript|javascript is (?:disabled|required)|this (?:site|page) requires javascript|attention required!?|(?:re|h)?captcha\b)/i;
const CAPTCHA_LINE = /\b(?:re|h)?captcha\b|\bturnstile\b/i;

/**
 * Only recognize empty text, whole short interstitial messages, and challenge lines near the
 * top of short pages; words inside articles never count.
 */
export function pageContentFailure(text: string): string | undefined {
  const normalized = text.replace(/^\s*#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
  if (!normalized) return "returned no readable content";
  if (/^(?:access denied|(?:401|403) (?:unauthorized|forbidden)|just a moment(?:\.{3}|…)?|checking your browser(?:\.{3}|…)?|please enable javascript and cookies to continue\.?|verify (?:that )?you are human[.!]?)$/i.test(normalized)) {
    return "returned an access challenge instead of page content";
  }
  if (normalized.length <= CHALLENGE_PAGE_CHARS) {
    const lines = text.slice(0, CHALLENGE_HEAD_CHARS).split(/\r?\n/).map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, "").trim());
    if (lines.some((line) => CHALLENGE_LINE.test(line) || line.length <= 200 && CAPTCHA_LINE.test(line) && /verif|robot|human|solve|complete/i.test(line))) {
      return "returned an access challenge instead of page content";
    }
  }
  return undefined;
}
