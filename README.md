# OpenAI Decisions MCP

An MCP server that exposes OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) as twelve purpose-built judgment tools. It is a feature-complete derivative of `jev-mcp`; the judgment transport has been replaced with `POST /v1/decisions` and the public tools use the `decisions_*` prefix.

## Tools

- `decisions_verify` — verify claims against evidence.
- `decisions_screen` — screen untrusted text for injection and low-value content.
- `decisions_noul` — return calibrated probabilities for propositions.
- `decisions_find` — choose the best candidate and estimate whether an answer exists.
- `decisions_rerank` — independently score and sort candidates.
- `decisions_classify` — classify batches against a shared catalog.
- `decisions_decide` — choose among bounded candidates and check requirements.
- `decisions_compare` — compare passages overall and by named aspects.
- `decisions_extract` — choose verbatim values from regex-generated candidates.
- `decisions_audit` — audit extracted records for fabrication, inconsistency, and omission.
- `decisions_review` — score a patch against a request.
- `decisions_gate` — combine patch review and completion-claim verification.

The server maps its internal question catalog to Decisions `predicate`, `choice`, and `score` questions, then maps the typed probabilities back to the original tool response contracts.

## Requirements

- Node.js 22+
- `OPENAI_API_KEY`
- Access to the Decisions API. It currently supports `gpt-6-luna`.

## Install and run

```bash
npm install
npm run build
OPENAI_API_KEY=... node dist/index.js
```

Codex MCP configuration:

```toml
[mcp_servers.openai-decisions]
command = "npx"
args = ["-y", "openai-decisions-mcp"]

[mcp_servers.openai-decisions.env]
OPENAI_API_KEY = "${OPENAI_API_KEY}"
```

For a source checkout, set `command = "node"` and point `args` at the absolute `dist/index.js` path.

## HTTP transport

```bash
OPENAI_API_KEY=... node dist/index.js --http
```

The default endpoint is `http://127.0.0.1:8080/mcp`. A non-loopback bind requires `OPENAI_DECISIONS_MCP_AUTH_TOKEN`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | OpenAI API credential. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API root; `/decisions` is appended. Useful for gateways and tests. |
| `OPENAI_ORG_ID` | unset | Optional OpenAI organization header. |
| `OPENAI_PROJECT_ID` | unset | Optional OpenAI project header. |
| `OPENAI_DECISIONS_MODEL` | `gpt-6-luna` | Decisions model. |
| `OPENAI_DECISIONS_MCP_REQUEST_TIMEOUT_MS` | `60000` | Whole-request deadline. |
| `OPENAI_DECISIONS_MCP_MAX_ATTEMPTS` | `3` | Attempts for 408, 409, 429, and 5xx responses. |
| `OPENAI_DECISIONS_MCP_TRANSPORT` | `stdio` | Set to `http` to enable HTTP mode. |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | HTTP bind address. |
| `OPENAI_DECISIONS_MCP_AUTH_TOKEN` | unset | Bearer token required for public HTTP binds. |

## Tests

```bash
npm test
npm run test:e2e
```

The E2E suite starts the real MCP stdio server and a local OpenAI-compatible Decisions endpoint, then calls `decisions_classify` through an MCP client. If `OPENAI_API_KEY` is present, it also enables an optional live Decisions smoke test.
