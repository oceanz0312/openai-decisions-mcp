# Contributing

Requires Node.js 22+.

```bash
npm install
npm run typecheck
npm test
npm run test:e2e
```

Keep question design in `src/server.ts` and wire adaptation in `src/provider.ts`. Never commit API keys or fixtures containing secrets.
