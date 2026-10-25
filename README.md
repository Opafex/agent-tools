# Opafex agent tools

Small, dependency-free building blocks for AI agents, extracted from the [Opafex](https://opafex.com) platform where they run in production.

| Package | What it does |
|---|---|
| [`@opafex/privacy`](./packages/privacy) | PII redaction for logs and LLM payloads. Same value, same token, so a redacted log is still debuggable. UK-aware. |
| [`@opafex/retrieval-core`](./packages/retrieval-core) | Retrieval for RAG: chunking, IDF-weighted rare-term matching, and a vector + keyword merge that catches what embeddings miss. |
| [`@opafex/grounding`](./packages/grounding) | Checks an agent's prose against its tool results: invented identifiers, citations the source does not support, contradictions, unsupported numbers. |

Each package has zero runtime dependencies, ships as ES modules with TypeScript types, and needs Node.js 20.19 or later.

MCP servers live in [opafex-mcps](https://github.com/opafex/opafex-mcps); the knowledge grid in [knowledge-grid](https://github.com/opafex/knowledge-grid).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT, see [LICENSE](./LICENSE).
