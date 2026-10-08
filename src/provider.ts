import type { DecisionQuestion } from "./questions.js";

export type DecisionsProvider = "openai";

export interface AskResult {
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
  provider: DecisionsProvider;
  model: string;
}

interface OpenAIChoiceQuestion {
  type: "choice";
  name: string;
  instructions: string;
  choices: Array<{ value: string; description: string }>;
}

interface OpenAIPredicateQuestion {
  type: "predicate";
  name: string;
  instructions: string;
}

interface OpenAIScoreQuestion {
  type: "score";
  name: string;
  instructions: string;
  levels: Array<{ label: string; description: string }>;
}

type OpenAIQuestion = OpenAIChoiceQuestion | OpenAIPredicateQuestion | OpenAIScoreQuestion;

interface NormalizedQuestion {
  source: DecisionQuestion;
  wire: OpenAIQuestion;
}

const positiveIntFromEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};

const REQUEST_TIMEOUT_MS = positiveIntFromEnv("OPENAI_DECISIONS_MCP_REQUEST_TIMEOUT_MS", 60_000);
const MAX_ATTEMPTS = Math.min(6, Math.max(1, positiveIntFromEnv("OPENAI_DECISIONS_MCP_MAX_ATTEMPTS", 3)));
const MAX_RESPONSE_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function decisionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/decisions") ? base : `${base}/decisions`;
}

function normalizeQuestion(name: string, value: unknown): NormalizedQuestion {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.instructions !== "string") {
    throw new Error(`Invalid decision question ${name}`);
  }

  if (value.type === "choice") {
    if (!isRecord(value.criteria)) throw new Error(`Decision question ${name} has invalid choices`);
    const choices = Object.entries(value.criteria).map(([choiceValue, description]) => {
      if (description !== null && typeof description !== "string") {
        throw new Error(`Decision question ${name} has an invalid choice description`);
      }
      return { value: choiceValue, description: description ?? `Choose ${choiceValue}` };
    });
    if (choices.length < 2) throw new Error(`Decision question ${name} must define at least two choices`);
    return {
      source: value as unknown as DecisionQuestion,
      wire: { type: "choice", name, instructions: value.instructions, choices },
    };
  }

  if (value.type === "noul") {
    if (!isRecord(value.criteria) || typeof value.criteria.true !== "string" || typeof value.criteria.false !== "string") {
      throw new Error(`Decision question ${name} has invalid predicate criteria`);
    }
    return {
      source: value as unknown as DecisionQuestion,
      wire: {
        type: "predicate",
        name,
        instructions: `${value.instructions}\n\nTrue means: ${value.criteria.true}\nFalse means: ${value.criteria.false}`,
      },
    };
  }

  if (value.type === "score") {
    if (!Array.isArray(value.criteria) || value.criteria.length < 2 || !value.criteria.every((item) => typeof item === "string")) {
      throw new Error(`Decision question ${name} has invalid score levels`);
    }
    return {
      source: value as unknown as DecisionQuestion,
      wire: {
        type: "score",
        name,
        instructions: value.instructions,
        levels: value.criteria.map((description, index) => ({ label: String(index), description })),
      },
    };
  }

  throw new Error(`Decision question ${name} has unsupported type ${value.type}`);
}

function probabilityMap(items: unknown): Record<string, number> {
  if (!Array.isArray(items)) throw new Error("Decision answer is missing probabilities");
  const result: Record<string, number> = {};
  for (const item of items) {
    if (!isRecord(item) || !("value" in item) || typeof item.probability !== "number" || !Number.isFinite(item.probability)) {
      throw new Error("Decision answer contains invalid probabilities");
    }
    result[String(item.value)] = item.probability;
  }
  return result;
}

function normalizeAnswer(answer: unknown, question: NormalizedQuestion): unknown {
  if (!isRecord(answer) || answer.name !== question.wire.name || typeof answer.type !== "string") {
    throw new Error(`Invalid answer for decision question ${question.wire.name}`);
  }
  if (answer.type === "refusal") throw new Error(`OpenAI refused decision question ${question.wire.name}`);

  if (question.source.type === "noul") {
    if (answer.type !== "predicate" || typeof answer.probability !== "number" || answer.probability < 0 || answer.probability > 1) {
      throw new Error(`Invalid predicate answer for decision question ${question.wire.name}`);
    }
    return { type: "noul", noul: answer.probability };
  }

  if (question.source.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string") {
      throw new Error(`Invalid choice answer for decision question ${question.wire.name}`);
    }
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: probabilityMap(answer.probabilities),
      confidence: typeof answer.confidence === "number" ? answer.confidence : null,
    };
  }

  if (answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
    throw new Error(`Invalid score answer for decision question ${question.wire.name}`);
  }
  return {
    type: "score",
    score: answer.score,
    probabilities: probabilityMap(answer.probabilities),
    confidence: typeof answer.confidence === "number" ? answer.confidence : null,
  };
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error(`OpenAI response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

async function waitForRetry(attempt: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2_000));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function postDecision(body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const url = decisionsUrl(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(process.env.OPENAI_ORG_ID ? { "OpenAI-Organization": process.env.OPENAI_ORG_ID } : {}),
        ...(process.env.OPENAI_PROJECT_ID ? { "OpenAI-Project": process.env.OPENAI_PROJECT_ID } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await readBounded(response);
    if (response.ok) {
      try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error("response is not an object");
        return parsed;
      } catch (error) {
        throw new Error(`OpenAI Decisions returned invalid JSON: ${(error as Error).message}`);
      }
    }
    if (retryable(response.status) && attempt < MAX_ATTEMPTS) {
      await waitForRetry(attempt, signal);
      continue;
    }
    throw new Error(`OpenAI Decisions request failed with HTTP ${response.status}: ${redact(raw.slice(0, 500), apiKey)}`);
  }
  throw new Error("OpenAI Decisions request failed");
}

export async function askDecisions(
  state: unknown,
  questions: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const normalized = Object.entries(questions).map(([name, question]) => normalizeQuestion(name, question));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`OpenAI Decisions request exceeded ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
  const relay = () => timeout.abort(signal?.reason);
  if (signal?.aborted) relay();
  else signal?.addEventListener("abort", relay, { once: true });
  try {
    const response = await postDecision({
      model,
      input: typeof state === "string" ? state : JSON.stringify(state),
      questions: normalized.map((item) => item.wire),
    }, timeout.signal);
    if (!Array.isArray(response.answers)) throw new Error("OpenAI Decisions response is missing answers");
    const byName = new Map<string, unknown>();
    for (const answer of response.answers) {
      if (isRecord(answer) && typeof answer.name === "string") byName.set(answer.name, answer);
    }
    const answers: Record<string, unknown> = {};
    for (const question of normalized) {
      answers[question.wire.name] = normalizeAnswer(byName.get(question.wire.name), question);
    }
    const usage = isRecord(response.usage) ? response.usage : {};
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    return {
      answers,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
      provider: "openai",
      model: typeof response.model === "string" && response.model ? response.model : model,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}
