import { describe, expect, it } from "vitest";
import { styled, toneForSeverity } from "../src/console/style.js";

describe("console styling", () => {
  it("emits exactly one style argument pair per tagged segment", () => {
    // A mismatch between %c directives and style arguments makes the browser
    // print a literal "%c" — the standard way this API gets broken.
    const [format, ...styles] = styled([["a", "bad"], " plain ", ["b", "dim"]]);
    const directives = (format.match(/%c/g) ?? []).length;
    expect(directives).toBe(styles.length);
    expect(styles).toHaveLength(4); // open+close for each of the two tagged segments
  });

  it("escapes percent signs so they are never read as directives", () => {
    const [format, ...styles] = styled([["100% avoidable", "warn"]]);
    expect(format).toContain("100%% avoidable");
    expect((format.match(/%c/g) ?? []).length).toBe(styles.length);
  });

  it("keeps the text intact, because colour must never be the only signal", () => {
    const [format] = styled([["  ▲ Row ×12", "warn"], "  9.1ms", ["  12 avoidable", "warn"]]);
    const plain = format.replace(/%c/g, "").replace(/%%/g, "%");
    expect(plain).toBe("  ▲ Row ×12  9.1ms  12 avoidable");
  });

  it("maps severity to tone worst-first", () => {
    expect(toneForSeverity("critical")).toBe("bad");
    expect(toneForSeverity("very-slow")).toBe("bad");
    expect(toneForSeverity("slow")).toBe("warn");
    expect(toneForSeverity("monitor")).toBe("dim");
    expect(toneForSeverity("normal")).toBe("plain");
  });
});
