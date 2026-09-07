# suped

Lose the harness. Let it cook.

A persistent Linux computer where any model can use real tools, run real
software, and produce real work.

| Directory | What it is |
|---|---|
| `cli/` | The `suped` npm package. `npx suped@latest` opens a shell in a persistent Linux computer. |
| `site/` | suped.ai, the one-page homepage. |

Docs and the product explanation live at https://suped.dev.

## Working on it

```
# homepage
cd site && npm install && npm run dev

# cli
cd cli && npm test
node bin/suped.js --help
```
