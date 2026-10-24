# Agent-Native Context (ANC) — Specification

**Version:** 1.1 (draft) · **Date:** 2026-10-19 · **Author:** Faisal Noorani · **License:** MIT · **Copyright:** © 2026 Proof Restoration ERP LLC

This document defines the `CONTEXT.agent.yaml` file and what a conforming checker does with it. It replaces version 1.0 (2026-10-19), which included performance figures that could not be reproduced and described enforcement the reference implementation did not perform. Those parts were withdrawn.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Purpose

An AI coding agent working in a large repository needs to know, for the code it is about to change: what must stay true, how to check that it stayed true, what it may change on its own, and what needs a person's sign-off. Prose instruction files (`AGENTS.md`, `CLAUDE.md`, Cursor rules) carry this as text the agent reads. ANC puts the same facts in a small structured file beside each module so that a program can check parts of them, and an agent can be given exactly the file for the code it is touching.

ANC does not make an agent correct. It makes some promises checkable and puts the rest in front of the agent at the right moment.

## 2. The contract file

- **Name and place.** A contract MUST be named `CONTEXT.agent.yaml` and SHOULD sit in the root directory of the module it describes (the directory holding that module's `package.json`, when there is one).
- **Scope.** A contract governs every file in its directory and below, until a deeper contract takes over. The contract for a file is the nearest `CONTEXT.agent.yaml` found by walking up from the file's directory to the workspace root.
- **Format.** YAML that MUST validate against the JSON Schema at `schemas/context-agent.schema.json` (published at `https://www.proofco.ai/schemas/context-agent.schema.json`). Unknown top-level keys are rejected.
- **Workspace schemas.** A workspace MAY use a stricter copy of the schema (for example, an enum of allowed `module.domain` values) at `<workspace>/schemas/context-agent.schema.json`; a checker MUST prefer it over the bundled one.

### 2.1 Sections

| Section | Required | Meaning |
|---|---|---|
| `module` | yes | `name`, `purpose`, `domain`, `path`; `package` is the package-manager name or null. |
| `dependencies` | no | `reads_from` / `writes_to`: lists of `{ module, via }`, where `via` is how the dependency is used (`import`, `rpc`, `event`, `file`, `cli`, …). `shared_tables`: data stores shared with other modules. |
| `invariants` | no | Rules that must stay true. Each has `id`, `rule`, `type` (`data`, `process`, `security`, `integrity`), optional `enforced_by` (files or mechanisms) and `test`. |
| `authority` | schema: no; `anc check`: yes | `autonomous`: actions an agent may take without asking. `founder_approval`: actions that need sign-off from the repository owner. `notes`. |
| `blast_radius` | no | `level` (`low`…`critical`), `upstream`, `downstream`, `data_impact`. |
| `health`, `entities`, `active_work`, `artifacts`, `tools_required`, `session_warmup` | no | Optional context. `health` is self-reported and is not used by the reference tooling. |

### 2.2 Invariant tests

- `test` is a shell command, or null when the invariant cannot be checked by a program.
- The command MUST be run from the **workspace root**. It holds when it exits 0.
- A test SHOULD target the invariant (a specific test file, script or check). Pointing at a whole package test suite is allowed but weak: it passes or fails for reasons unrelated to the invariant.

## 3. What a conforming checker does (`anc check`)

A checker MUST report a failure for each of the following:

1. **Schema.** A contract that does not parse or does not validate.
2. **Authority.** A contract whose `authority.autonomous` or `authority.founder_approval` is missing or empty.
3. **Placeholders.** A contract that still carries the text `anc init` writes (purpose, invariant rule, sign-off line).
4. **Dependency parity, forward.** A `reads_from` entry with `via: import` whose module is not declared in the module's `package.json` `dependencies` or `peerDependencies`. A bare module name that matches a workspace package means that workspace package (so `core` is satisfied by the workspace's `@acme/core`, not by `@capacitor/core`).
5. **Dependency parity, reverse.** A workspace package declared in `dependencies` or `peerDependencies` that the contract lists in neither `reads_from` nor `writes_to`.
6. **Workspace cycles.** A cycle in the graph of workspace packages (edges from `dependencies`, `devDependencies` and `peerDependencies`).
7. **Oracle integrity.** For each invariant `test`: a path containing `/` that does not exist, or a script file handed to an interpreter (`node`, `tsx`, `bash`, `sh`, `python`, …) that does not exist (both relative to the root, or to a preceding `cd`); an `npm run <script>` whose script is not defined in the target `package.json` (`--prefix`, `-w` / `--workspace` honoured; pnpm and yarn are not looked up); or a command that cannot fail (`true`, `exit 0`, `echo …`, `node -e "process.exit(0)"`, or a command whose last step is `|| true`, `|| :` or `; exit 0`).

Parity is checked only for contracts that sit beside a `package.json`. Workspace packages are found by walking the workspace for `package.json` files, skipping `node_modules`, build output and any nested workspace (a directory whose `package.json` declares `workspaces`).

**Security.** `anc verify` runs the `test` commands the contracts contain, with a shell. Do not run it on changes from people you do not trust (for example, pull requests from forks). A change can also add its own `schemas/context-agent.schema.json`, which `check` prefers; review schema changes like code.

**Not checked.** The checker reads manifests and YAML. It does not parse source code, so an import that is missing from `package.json` is not caught here (use a tool such as knip for that). It does not judge whether a test actually exercises its invariant.

## 4. Other operations

- **`anc query <path|package>`** prints the contract for a file, directory or package in a compact form for an agent: purpose, invariants with their tests, authority, dependencies, blast radius. Self-reported `health` is not printed.
- **`anc trace <path> [--depth <n>] [--batch <dir>]`** inspects source code AST and imports to extract the exact runtime execution context (`client-component`, `server-component`, `route-handler`, `background-worker`, `library-module`, `test-suite`), rendered child JSX components paired with source paths, outbound and inbound API routes, database tables with `tenant_id` isolation checks, background Inngest events, and custom domain hooks, coupled with the nearest module invariants. Supports transitive wire resolution across local imports via `--depth <n>`, and whole-directory architecture summaries via `--batch <dir>`.
- **`anc verify <targets…> | --all | --changed <ref>`** runs the `test` commands of the selected contracts from the workspace root. Identical commands run once. It exits non-zero if any command fails.
- **`anc stats`** counts contracts, invariants, invariants with and without a test, and tests that are **targeted** versus **broad**. A test is targeted when it names a script or test file that is not a config file (`.js/.mjs/.cjs/.ts/.tsx/.sh/.py`, excluding `tsconfig*`, `*.config.*` and `package.json`), runs an npm script other than `build`, `test`, `lint`, `typecheck` or `type-check`, or runs inline code (`node -e`). Every other test is broad: a whole package's or directory's tests, a typecheck, a lint or a build.
- **`anc init [dir] | --all`** writes a skeleton contract. The skeleton fails `anc check` until its placeholders are replaced.

## 5. Agent integration

- **Claude Code.** A `PreToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit` resolves the contract for the target file and returns both the module contract and the target file's live Code Topology & Wire Trace as `hookSpecificOutput.additionalContext` (plain stdout from a `PreToolUse` hook is not shown to the model). It sends a module's contract at most once every 30 minutes within a session (so it can return after context compaction) and never blocks a tool call. Blocking edits to protected paths is a separate concern; use Claude Code permission rules or a path-based hook.
- **Other agents.** Any agent that can run a command can call `anc query` or `anc trace` before editing and `anc verify` before finishing. A Cursor rule is provided.

The `authority` section is context for the agent. ANC does not enforce it.

## 6. Relationship to other work

- **Nested instruction files.** `AGENTS.md` (nearest file wins), Claude Code's subdirectory `CLAUDE.md` files and Cursor's glob-scoped rules already give an agent instructions scoped to the code it touches. ANC uses the same nearest-file idea for structured data that a program can check.
- **Interpretable Context Methodology (ICM).** Van Clief and McDermott use folder structure and per-stage `CONTEXT.md` files as the architecture for agent workflows (arXiv:2603.16021, 2026). In the repository where ANC was developed, `CONTEXT.agent.yaml` sits beside an ICM-style `CONTEXT.md`: the Markdown file explains, the YAML file is checked.
- **Module-boundary tools.** Nx `enforce-module-boundaries` and dependency-cruiser enforce dependency rules and detect cycles from source imports; knip reports unlisted and unused dependencies. ANC's parity and cycle checks work from manifests only and are narrower.
- **Design by Contract.** The vocabulary (invariants, checks run around a change) follows Meyer's Design by Contract. ANC's checks are executable tests, not proofs.

## 7. Reference implementation

`github.com/Proof-Company/agent-native-context` (MIT). Node.js ≥ 18; dependencies `ajv` and `yaml`. It is not published to a package registry: clone it, run `npm install`, and use `node bin/anc.mjs`. `node bin/anc.mjs selftest` plants one violation for each rule in §3 and requires each to fail.

## References

- Meyer, B. (1992). Applying "design by contract". *Computer*, 25(10), 40–51. doi:10.1109/2.161279
- Liu, N. F., et al. (2024). Lost in the middle: How language models use long contexts. *TACL*, 12, 157–173. doi:10.1162/tacl_a_00638
- Van Clief, J., & McDermott, D. (2026). Interpretable Context Methodology: Folder Structure as Agentic Architecture. arXiv:2603.16021
- AGENTS.md — https://agents.md/
- Claude Code hooks — https://code.claude.com/docs/en/hooks · memory — https://code.claude.com/docs/en/memory
