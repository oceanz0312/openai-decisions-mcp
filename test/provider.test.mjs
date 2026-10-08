import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { askDecisions } from "../dist/provider.js";

test("provider maps predicate, choice, and score answers", async () => {
  const previous = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      assert.deepEqual(body.questions.map((question) => question.type), ["predicate", "choice", "score"]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: [
        { type: "predicate", name: "relevant", probability: 0.8 },
        { type: "choice", name: "route", choice: "billing", probabilities: [
          { value: "billing", probability: 0.9 }, { value: "other", probability: 0.1 },
        ], confidence: 0.8 },
        { type: "score", name: "severity", score: 1.5, probabilities: [
          { value: 0, label: "0", probability: 0.1 },
          { value: 1, label: "1", probability: 0.3 },
          { value: 2, label: "2", probability: 0.6 },
        ], confidence: 0.7 },
      ], usage: { input_tokens: 12 }, model: "gpt-6-luna" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const result = await askDecisions({ text: "fixture" }, {
      relevant: { type: "noul", instructions: "Is this relevant?", criteria: { true: "yes", false: "no" } },
      route: { type: "choice", instructions: "Route it", criteria: { billing: "Billing", other: "Other" } },
      severity: { type: "score", instructions: "Rate severity", criteria: ["Low", "Medium", "High"] },
    }, "gpt-6-luna");
    assert.equal(result.answers.relevant.noul, 0.8);
    assert.equal(result.answers.route.choice, "billing");
    assert.equal(result.answers.severity.score, 1.5);
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 0 });
  } finally {
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.base;
    server.close();
    server.closeAllConnections();
  }
});

test("provider requires OPENAI_API_KEY and redacts reflected secrets", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(() => askDecisions("x", {
      q: { type: "noul", instructions: "?", criteria: { true: "yes", false: "no" } },
    }, "gpt-6-luna"), /OPENAI_API_KEY/);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});
