// web_search: DDG HTML parsing, caps, and error surfacing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthorTools, buildTools } from "../src/tools";
import { MAX_WEB_RESULTS, searchWeb } from "../src/web-search";

const resultBlock = (i: number) => `
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage${i}&amp;rut=x${i}">Result ${i} &amp; co</a></h2>
    <div class="result__snippet_wrap"><a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage${i}&amp;rut=x${i}">Snippet text for result ${i} with &lt;tags&gt; stripped.</a></div>
  </div>`;

const ddgHtml = (blocks: string) =>
  `<!DOCTYPE html><html><body>${blocks}<div class="no-results">other markup ignored</div></body></html>`;

describe("searchWeb parsing", () => {
  test("parses titles, snippets, and decodes DDG redirect URLs", async () => {
    const fakeFetch = (async () =>
      new Response(
        ddgHtml(
          resultBlock(1) +
            `<div class="result"><h2><a rel="nofollow" class="result__a" href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview">HTTP &amp; URLs</a></h2>
             <a class="result__snippet" href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview">HTTP is the protocol the web runs on</a></div>`,
        ),
      )) as typeof fetch;
    const results = await searchWeb("routing", fakeFetch);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Result 1 & co",
      url: "https://example.com/page1",
      snippet: "Snippet text for result 1 with <tags> stripped.",
    });
    expect(results[1]).toEqual({
      title: "HTTP & URLs",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview",
      snippet: "HTTP is the protocol the web runs on",
    });
  });

  test("caps at MAX_WEB_RESULTS", async () => {
    const fakeFetch = (async () =>
      new Response(ddgHtml(Array.from({ length: 9 }, (_, i) => resultBlock(i)).join("")))) as typeof fetch;
    const results = await searchWeb("many", fakeFetch);
    expect(results).toHaveLength(MAX_WEB_RESULTS);
  });

  test("no result anchors -> []", async () => {
    const fakeFetch = (async () => new Response(ddgHtml(""))) as typeof fetch;
    expect(await searchWeb("nothing", fakeFetch)).toEqual([]);
  });

  test("non-OK response throws", async () => {
    const fakeFetch = (async () => new Response("blocked", { status: 503 })) as typeof fetch;
    await expect(searchWeb("x", fakeFetch)).rejects.toThrow(/web search 503/);
  });

  test("transport error propagates", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(searchWeb("x", fakeFetch)).rejects.toThrow("fetch failed");
  });
});

describe("web_search tool", () => {
  const makeCtx = () => {
    const courseRoot = mkdtempSync(join(tmpdir(), "lyceum-search-"));
    return {
      ctx: { courseRoot, modules: [] },
      cleanup: () => {
        try {
          rmSync(courseRoot, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  };

  test("author tool set exposes web_search; execute returns results", async () => {
    const { ctx, cleanup } = makeCtx();
    const tools = buildAuthorTools(ctx, { search: async () => [{ title: "T", url: "https://u", snippet: "s" }] });
    const r = await tools.web_search.execute({ query: "express" });
    expect(r).toEqual({ ok: true, query: "express", results: [{ title: "T", url: "https://u", snippet: "s" }] });
    cleanup();
  });

  test("search failure becomes ok:false tool output, not a crash", async () => {
    const { ctx, cleanup } = makeCtx();
    const tools = buildAuthorTools(ctx, {
      search: async () => {
        throw new Error("rate limited");
      },
    });
    const r = await tools.web_search.execute({ query: "express" });
    expect(r.ok).toBe(false);
    expect(String((r as { message?: string }).message)).toContain("rate limited");
    cleanup();
  });

  test("learner tool set does NOT expose web_search", () => {
    const { ctx, cleanup } = makeCtx();
    const learner = buildTools(ctx);
    expect(learner).not.toHaveProperty("web_search");
    cleanup();
  });
});
