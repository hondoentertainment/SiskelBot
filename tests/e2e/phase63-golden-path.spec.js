import { test, expect } from "@playwright/test";

const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  "x-admin-api-key": process.env.ADMIN_API_KEY || "e2e-admin-key",
};

const SAMPLE_DIFF = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,2 +1,4 @@
 function foo() {
+  console.log("debug");
   return 1;
 }
`;

const SAMPLE_LCOV = `SF:src/foo.js
DA:1,1
DA:2,0
DA:3,1
LF:3
LH:2
end_of_record
`;

test.describe("Phase 63 golden path", () => {
  const workspace = "e2e-phase63";

  test("repo-rag → pr-review → test-gen flow", async ({ request }) => {
    const indexRes = await request.post("/api/v1/repo-rag/index", {
      headers: ADMIN_HEADERS,
      data: {
        workspaceId: workspace,
        repoId: "golden-repo",
        files: [
          {
            path: "src/foo.js",
            content: "export function foo() { return 42; }\nexport function bar() { return foo(); }",
          },
        ],
      },
    });
    expect(indexRes.status()).toBe(201);
    const indexed = await indexRes.json();
    expect(indexed.repoId).toBe("golden-repo");
    expect(indexed.fileCount).toBe(1);

    const searchRes = await request.get("/api/v1/repo-rag/search", {
      headers: ADMIN_HEADERS,
      params: { workspaceId: workspace, query: "foo" },
    });
    expect(searchRes.status()).toBe(200);
    const search = await searchRes.json();
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0].path).toBe("src/foo.js");

    const reviewRes = await request.post("/api/v1/pr-review/review", {
      headers: ADMIN_HEADERS,
      data: { workspaceId: workspace, diff: SAMPLE_DIFF },
    });
    expect(reviewRes.status()).toBe(201);
    const review = await reviewRes.json();
    expect(review.reviewId).toBeTruthy();
    expect(review.comments.some((c) => c.rule === "no-console-log")).toBe(true);

    const analyzeRes = await request.post("/api/v1/test-gen/analyze", {
      headers: ADMIN_HEADERS,
      data: { workspaceId: workspace, lcov: SAMPLE_LCOV },
    });
    expect(analyzeRes.status()).toBe(201);
    const gaps = await analyzeRes.json();
    expect(gaps.gaps.length).toBeGreaterThan(0);

    const generateRes = await request.post("/api/v1/test-gen/generate", {
      headers: ADMIN_HEADERS,
      data: {
        workspaceId: workspace,
        modulePath: "src/foo.js",
        uncoveredLines: gaps.gaps[0].uncoveredLines,
        moduleSource: "export function foo() { return 42; }",
      },
    });
    expect(generateRes.status()).toBe(201);
    const generated = await generateRes.json();
    expect(generated.stub).toContain("node:test");
    expect(generated.record.modulePath).toBe("src/foo.js");
  });
});
