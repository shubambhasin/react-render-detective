/**
 * Console colouring.
 *
 * Browsers support `%c` styling; terminals print the directive literally, so it
 * is feature-detected and degrades to plain text.
 *
 * Colour never carries meaning on its own. Every line keeps its glyph and its
 * words — `▲`, `12 avoidable`, `rebuilt` — so the output survives being copied
 * into an issue, read by someone with a different colour palette, or printed by
 * a reporter that strips styling.
 */
export type Tone = "plain" | "dim" | "strong" | "good" | "warn" | "bad";

/**
 * Mid-tone values, chosen to stay legible against both light and dark console
 * backgrounds — DevTools follows the OS theme and the author does not get to
 * pick which one you use.
 */
const PALETTE: Record<Tone, string> = {
  plain: "",
  dim: "color:#8a94a6",
  strong: "font-weight:600",
  good: "color:#1f9d5b",
  warn: "color:#c2820a",
  bad: "color:#d1493f;font-weight:600",
};

export type Segment = string | [text: string, tone: Tone];

const supportsStyling = (): boolean => {
  try {
    return typeof window !== "undefined" && typeof document !== "undefined";
  } catch {
    return false;
  }
};

/**
 * Builds `console.log` arguments from tagged segments.
 *
 * The count of `%c` directives and style arguments is guaranteed to match by
 * construction: a mismatch makes the browser print a literal `%c`, which is the
 * usual way this API gets broken.
 */
export function styled(segments: Segment[]): [string, ...string[]] {
  if (!supportsStyling()) {
    return [segments.map((s) => (typeof s === "string" ? s : s[0])).join("")];
  }

  let format = "";
  const styles: string[] = [];
  for (const segment of segments) {
    if (typeof segment === "string") {
      // Escape any literal % so it cannot be read as a directive.
      format += segment.replace(/%/g, "%%");
      continue;
    }
    const [text, tone] = segment;
    format += `%c${text.replace(/%/g, "%%")}%c`;
    styles.push(PALETTE[tone], "");
  }
  return [format, ...styles];
}

/** Tone for a render's severity, following the configured thresholds. */
export function toneForSeverity(severity: string): Tone {
  switch (severity) {
    case "critical":
    case "very-slow":
      return "bad";
    case "slow":
      return "warn";
    case "monitor":
      return "dim";
    default:
      return "plain";
  }
}
