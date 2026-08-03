// Transcript regression tests: scroll windowing + streaming coalescing.
import { describe, expect, test } from "bun:test";
import { Transcript } from "../src/tui/App";

function fill(t: Transcript, n: number): void {
  for (let i = 0; i < n; i++) t.add({ who: "note", text: `note ${i}` });
}

describe("Transcript scroll", () => {
  test("viewport windows by scrollOffset once content overflows", () => {
    const t = new Transcript();
    fill(t, 30);
    t.setHeight(4);
    // Default followTail + setHeight re-follow: the tail is in view.
    const initial = t.render(80);
    expect(initial[initial.length - 1]).toContain("note 29");
    t.setScrollOffset(10);
    const scrolled = t.render(80);
    expect(scrolled[0]).toContain("note 10");
    expect(scrolled[0]).not.toContain("note 0");
  });

  test("followTail tracks the bottom; manual scroll stops following", () => {
    const t = new Transcript();
    fill(t, 30);
    t.setHeight(4);
    // Default followTail=true: after the last add the view shows the tail.
    const tail = t.render(80);
    expect(tail[tail.length - 1]).toContain("note 29");
    // Browse history.
    t.setFollowTail(false);
    t.setScrollOffset(0);
    expect(t.render(80)[0]).toContain("note 0");
    // New content while browsing must not yank the view.
    t.add({ who: "note", text: "note 30" });
    expect(t.render(80)[0]).toContain("note 0");
    // Re-follow snaps back to the tail.
    t.setFollowTail(true);
    const back = t.render(80);
    expect(back[back.length - 1]).toContain("note 30");
  });
});

describe("Transcript streaming", () => {
  test("deltas coalesce: latest text renders within one tick", async () => {
    const t = new Transcript();
    t.add({ who: "user", text: "q" });
    t.setLive("hel");
    t.setLive("hello");
    t.setLive("hello world");
    // Flush is scheduled, not synchronous: nothing rendered yet.
    expect(t.render(80).join("\n")).not.toContain("hello world");
    await new Promise((r) => setTimeout(r, 60));
    expect(t.render(80).join("\n")).toContain("hello world");
  });

  test("commitLive flushes pending text and promotes to settled", () => {
    const t = new Transcript();
    t.add({ who: "user", text: "q" });
    t.setLive("final answer");
    t.commitLive(); // no await — flush happens synchronously on commit
    const rows = t.render(80).join("\n");
    expect(rows).toContain("final answer");
    // Promoted: a later stream appends, it doesn't replace.
    t.setLive("second");
    t.commitLive();
    const rows2 = t.render(80).join("\n");
    expect(rows2).toContain("final answer");
    expect(rows2).toContain("second");
  });

  test("dropLive discards the partial stream", () => {
    const t = new Transcript();
    t.add({ who: "user", text: "q" });
    t.setLive("partial");
    t.dropLive();
    expect(t.render(80).join("\n")).not.toContain("partial");
  });
});
