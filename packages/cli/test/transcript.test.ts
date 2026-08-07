// Transcript regression tests: unbounded render + native-scrollback seams.
//
// The transcript commits settled rows to terminal scrollback and repaints only
// the live stream suffix. Scroll state (offsets, followTail) is gone — what
// must hold instead: settled rows are byte-stable (same references across
// renders), the seam advances on commit, and the stability report keeps a
// streamed delta from re-ingesting history.
import { describe, expect, test } from "bun:test";
import { Transcript } from "../src/tui/App";

function fill(t: Transcript, n: number): void {
  for (let i = 0; i < n; i++) t.add({ who: "note", text: `note ${i}` });
}


describe("Transcript finality", () => {
  test("settled rows are stable: same references across renders", () => {
    const t = new Transcript();
    fill(t, 30);
    const first = t.render(80);
    const again = t.render(80);
    // Byte-identity proof for the engine: unchanged content returns the same array.
    expect(again).toBe(first);
    expect(first.length).toBe(30);
    expect(first[first.length - 1]).toContain("note 29");
  });

  test("add appends a new final row; older rows keep their references", () => {
    const t = new Transcript();
    fill(t, 30);
    const before = t.render(80);
    t.add({ who: "note", text: "note 30" });
    const after = t.render(80);
    expect(after.length).toBe(before.length + 1);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(after[after.length - 1]).toContain("note 30");
  });

  test("rows re-wrap per width; the width cache restores the original rows", () => {
    const t = new Transcript();
    t.add({ who: "note", text: "this is a long note line that will wrap at narrow widths" });
    const wide = t.render(80);
    const narrow = t.render(40);
    expect(narrow.length).toBeGreaterThan(wide.length);
    const wideAgain = t.render(80);
    expect(wideAgain).toBe(wide);
  });
});

describe("Transcript scrollback seam", () => {
  test("no live stream: the whole frame is final (seam at the end)", () => {
    const t = new Transcript();
    fill(t, 5);
    t.render(80);
    expect(t.getNativeScrollbackLiveRegionStart()).toBe(5);
  });

  test("live stream: seam sits at the settled count; live rows are the mutable suffix", () => {
    const t = new Transcript();
    fill(t, 5);
    t.setLive("thinking…");
    const rows = t.render(80);
    expect(rows[rows.length - 1]).toContain("thinking…");
    expect(t.getNativeScrollbackLiveRegionStart()).toBe(5);
  });

  test("commitLive promotes the stream: seam advances and rows become final", () => {
    const t = new Transcript();
    fill(t, 5);
    t.setLive("final answer");
    t.commitLive();
    const rows = t.render(80);
    expect(rows[rows.length - 1]).toContain("final answer");
    expect(t.getNativeScrollbackLiveRegionStart()).toBe(6);
    // Promoted rows are byte-stable like any other settled row.
    const again = t.render(80);
    expect(again).toBe(rows);
  });

  test("dropLive discards the stream: seam retreats, content is gone", () => {
    const t = new Transcript();
    fill(t, 5);
    t.setLive("partial");
    t.dropLive();
    const rows = t.render(80);
    expect(rows.join("\n")).not.toContain("partial");
    expect(rows.length).toBe(5);
    expect(t.getNativeScrollbackLiveRegionStart()).toBe(5);
  });
});

describe("Transcript stability report", () => {
  test("settled change dumps the report; a clean render restores it", () => {
    const t = new Transcript();
    fill(t, 5);
    t.render(80);
    // Width-miss render: nothing proven byte-stable yet; the read re-bases.
    expect(t.getRenderStablePrefixRows()).toBe(0);
    // Unchanged content: the cached rows are now provably stable.
    expect(t.getRenderStablePrefixRows()).toBe(5);
    // A settled change invalidates the prefix: report must read 0…
    t.add({ who: "note", text: "note 5" });
    expect(t.getRenderStablePrefixRows()).toBe(0);
    // …and stays 0 after the re-render (width miss again), then stabilizes.
    t.render(80);
    expect(t.getRenderStablePrefixRows()).toBe(0);
    expect(t.getRenderStablePrefixRows()).toBe(6);
  });

  test("a streamed delta does not dirty the settled prefix", () => {
    const t = new Transcript();
    fill(t, 5);
    t.render(80);
    expect(t.getRenderStablePrefixRows()).toBe(0); // first-read re-base
    expect(t.getRenderStablePrefixRows()).toBe(5); // stable now
    t.setLive("streaming…");
    t.render(80);
    // The engine can keep the settled prefix and re-ingest only the live line.
    expect(t.getRenderStablePrefixRows()).toBe(5);
  });
});
