import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("end to end: MCP stdio -> OpenAI Decisions -> decisions_classify", async () => {
  let captured;
  const mockOpenAI = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
      const question = captured.body.questions[0];
      const values = question.choices.map((choice) => choice.value);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "gpt-6-luna",
        usage: { input_tokens: 23 },
        answers: [{
          type: "choice",
          name: question.name,
          choice: values[0],
          probabilities: values.map((value, index) => ({ value, probability: index === 0 ? 0.9 : 0.05 })),
          confidence: 0.85,
        }],
      }));
    });
  });
  await new Promise((resolve) => mockOpenAI.listen(0, "127.0.0.1", resolve));

  const client = new Client({ name: "openai-decisions-mcp-e2e", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${mockOpenAI.address().port}/v1`,
      OPENAI_DECISIONS_MODEL: "gpt-6-luna",
    },
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 12);
    assert.ok(listed.tools.some((tool) => tool.name === "decisions_classify"));

    const result = await client.callTool({
      name: "decisions_classify",
      arguments: {
        items: [{ id: "complaint", text: "I was charged twice." }],
        classes: [
          { id: "billing", description: "Payments and refunds" },
          { id: "technical", description: "Product failures" },
          { id: "other", description: "Everything else" },
        ],
      },
    });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content.find((item) => item.type === "text").text);
    assert.equal(payload.tool, "decisions_classify");
    assert.equal(payload.provider, "openai");
    assert.equal(payload.model, "gpt-6-luna");
    assert.equal(payload.results[0].classification, "billing");
    assert.deepEqual(payload.usage, { input_tokens: 23, output_tokens: 0 });
  } finally {
    await client.close();
    mockOpenAI.close();
    mockOpenAI.closeAllConnections();
  }

  assert.equal(captured.path, "/v1/decisions");
  assert.equal(captured.authorization, "Bearer test-key");
  assert.equal(captured.body.model, "gpt-6-luna");
  assert.equal(captured.body.questions[0].type, "choice");
  assert.equal(JSON.parse(captured.body.input).classes.length, 3);
});

test("optional live Decisions API smoke test", { skip: !process.env.OPENAI_API_KEY }, async () => {
  const { askDecisions } = await import("../dist/provider.js");
  const result = await askDecisions(
    "The customer was charged twice.",
    {
      department: {
        type: "choice",
        instructions: "Which department should handle this?",
        criteria: { billing: "Payments and refunds", technical: "Product failures", other: "Everything else" },
      },
    },
    "gpt-6-luna",
  );
  assert.ok(["billing", "technical", "other"].includes(result.answers.department.choice));
});
