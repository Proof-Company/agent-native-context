# Agent-Native Context (ANC)

Small, checkable contracts that sit beside each module of a repository and tell an AI coding agent what must stay true there, how to check it, and what needs a person's sign-off. This repo holds the file format, its JSON Schema, and a CLI that checks contracts and hands the right one to the agent.

<!-- CONTRACT:BEGIN — hand-authored. The generator preserves everything between these markers. -->

## Contract

**Inputs:** Node.js 18+, file system, `package.json`, and YAML context schemas.

**Outputs:** CLI tool `anc` (query, check, init), programmatic exports, and TypeScript definitions.

**Invariants:**
- Self-Verification Invariant: The `anc` CLI must pass all built-in selftest assertions on invocation.
- AST Manifest Parity: Dependencies declared in `CONTEXT.agent.yaml` must match `package.json`.
- Authority Scoping: Every module must declare explicit `autonomous` and `founder_approval` authority blocks.

**Proves healthy:** `npm --prefix packages/anc test`

**Do NOT load for:** High-level agent orchestration workflows -> `.agents/skills/intelligent-proof-loop`.

<!-- CONTRACT:END -->

---

> **Status: early.** We started using ANC on 2026-10-16 in one TypeScript monorepo. We have not measured its effect on agent behaviour. An earlier version of this README and of our blog post stated results we could not reproduce; they were removed. See [SPECIFICATION.md](./SPECIFICATION.md) for exactly what the tooling does and does not check.

## The file

`CONTEXT.agent.yaml`, in the module's directory:

```yaml
module:
  name: money
  package: "@example/money"
  purpose: Integer-cent money arithmetic shared by every app
  domain: payments
  path: packages/money/

dependencies:
  reads_from: []
  writes_to: []

invariants:
  - id: money-01
    rule: Amounts are integer cents; no floating-point money math
    type: data
    enforced_by: [packages/money/src/index.js, packages/money/test/cents.test.mjs]
    test: node --test packages/money/test/cents.test.mjs   # run from the workspace root

authority:
  autonomous:
    - Add helpers that keep amounts in integer cents, with tests
  founder_approval:
    - Change rounding rules or the unit amounts are stored in

blast_radius:
  level: high
  downstream: [web]
  data_impact: A wrong rounding rule mis-prices every checkout.
```

## What the CLI does

| Command | What it does |
|---|---|
| `anc check` | Fails on: schema errors; empty `authority` lists; unreplaced `anc init` placeholders; a `reads_from` import missing from `package.json`; a workspace dependency in `package.json` missing from the contract; cycles between workspace packages; invariant tests that reference files or npm scripts that don't exist, or that can't fail (`true`, `exit 0`, `… \|\| true`). pnpm/yarn scripts are not looked up. |
| `anc query <path\|package>` | Prints the nearest contract for a file, directory or package, formatted for an agent. |
| `anc trace <path> [--depth <n>] [--batch <dir>]` | Traces runtime execution context (`client-component`, `server-component`, `route-handler`, `background-worker`), child JSX components, outbound/inbound APIs, database tables with `tenant_id` isolation checks, and background events, coupled with module invariants. |
| `anc verify <path…> \| --all \| --changed <ref>` | Runs the invariants' `test` commands from the workspace root; non-zero exit if any fails. |
| `anc stats` | Counts contracts, invariants, and targeted vs broad tests (broad = a whole package's tests, typecheck, lint or build). |
| `anc init [dir] \| --all` | Writes a skeleton that fails `check` until you fill it in. |
| `anc selftest` | Plants one violation per rule and requires each to fail. Run with `trace --selftest` for topology selftests. |

`anc check` validates manifests and YAML contracts against schemas and package graphs. `anc trace` parses source files to extract live code topology (connectors & wires) and passes them to agents via CLI and hooks. Pair with [knip](https://knip.dev) for dead-code pruning.

## Run it

Not published to npm. Run from a clone (Node.js 18+):

```bash
git clone https://github.com/Proof-Company/agent-native-context.git tools/anc
(cd tools/anc && npm install)
node tools/anc/bin/anc.mjs check
node tools/anc/bin/anc.mjs query packages/money/src/index.js
node tools/anc/bin/anc.mjs verify --changed origin/main
```

Try the bundled example workspace: `npm run example` (inside the clone).

## Agent integrations

- **Claude Code** — [`integrations/claude-code/anc-context.mjs`](./integrations/claude-code/anc-context.mjs) is a `PreToolUse` hook for `Edit|Write|MultiEdit|NotebookEdit`. Before an edit it returns that module's contract as `additionalContext` (at most once per module every 30 minutes in a session), which is how a `PreToolUse` hook gets text in front of the model. It never blocks an edit. Wiring is in the file header.
- **Cursor** — [`integrations/cursor/rules/anc.mdc`](./integrations/cursor/rules/anc.mdc): query before editing, verify before finishing.
- **GitHub Actions** — [`integrations/github-actions/anc-ci.yml`](./integrations/github-actions/anc-ci.yml): fetches this repo at a commit you pin and runs `anc check`. It runs `check` only, not `verify`, so it is safe on pull requests from forks.

The `authority` section is guidance for the agent. ANC does not enforce it; use your agent's permission rules or a path-based hook to block protected files.

**Security:** `anc verify` runs the shell commands written in the contracts. Don't run it on untrusted changes (for example, pull requests from forks). A change that adds its own `schemas/context-agent.schema.json` changes what `check` accepts; review it like code.

## Library

```js
import { check, resolveContext, formatContext, verify } from "./tools/anc/lib/index.mjs";
```

Types are in [`index.d.ts`](./index.d.ts).

## Prior art

ANC borrows the nearest-file idea from nested `AGENTS.md` / `CLAUDE.md` files and Cursor's scoped rules, and was built beside an [Interpretable Context Methodology](https://arxiv.org/abs/2603.16021) (Van Clief & McDermott, 2026) `CONTEXT.md` layout. Nx module boundaries, dependency-cruiser and knip check more from source; ANC's checks are narrower and work from manifests. Details in [SPECIFICATION.md §6](./SPECIFICATION.md#6-relationship-to-other-work).

## License

MIT © 2026 Proof Restoration ERP LLC
