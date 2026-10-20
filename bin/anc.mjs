#!/usr/bin/env node
// anc — the Agent-Native Context CLI. A thin shell over ../lib/index.mjs; all logic lives there.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    check,
    findContextFiles,
    findWorkspaceRoot,
    formatContext,
    resolveContext,
    stats,
    verify,
    workspacePackages,
    writeScaffold,
} from "../lib/index.mjs";
import { selftest } from "../lib/selftest.mjs";

const HELP = `anc — Agent-Native Context

Usage:
  anc query <path|package> [--json]       Print the nearest contract for a file, directory or package
  anc check [--check-deps]                Schema, authority, placeholders, dependency parity (both
                                          directions), workspace cycles, invariant-oracle integrity
  anc verify <path|package>... | --all | --changed <git-ref> [--timeout <sec>]
                                          Run the invariants' test commands from the workspace root
  anc stats [--json]                      Count contracts, invariants and test oracles
  anc init [dir] | --all                  Scaffold CONTEXT.agent.yaml (fails check until filled in)
  anc selftest                            Plant one violation per rule and require each to fail

Options:
  --root <dir>   Workspace root (default: found from the current directory)
`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
};
const positional = argv.filter(
    (a, i) => !a.startsWith("-") && !["--root", "--changed", "--timeout"].includes(argv[i - 1]),
);
const cmd = positional[0];
const root = value("--root") ? resolve(value("--root")) : findWorkspaceRoot();
// Paths on the command line are relative to where you run anc; package names (@scope/x, bare names) are not paths.
const asTarget = (t) =>
    t.startsWith("@") || (!/[\\/]/.test(t) && !existsSync(resolve(t))) ? t : resolve(t);

function exit(code) {
    process.exitCode = code;
}

if (cmd === "selftest" || flag("--selftest")) {
    exit(selftest() ? 0 : 1);
} else if (!cmd || flag("--help") || flag("-h")) {
    console.log(HELP);
} else if (cmd === "query") {
    const target = positional[1];
    const res = target ? resolveContext(root, asTarget(target)) : null;
    if (!res) {
        console.error(
            target
                ? `anc: no CONTEXT.agent.yaml found for "${target}"`
                : "usage: anc query <path|package> [--json]",
        );
        exit(1);
    } else
        console.log(
            flag("--json")
                ? JSON.stringify({ file: res.file, doc: res.doc }, null, 2)
                : formatContext(res),
        );
} else if (cmd === "check") {
    const r = check(root);
    for (const l of r.lines) (l.includes("FAIL") ? console.error : console.log)(l);
    console.log(
        r.ok
            ? `\ncheck PASS: ${findContextFiles(root).length} contract(s)`
            : `\ncheck FAIL: ${r.failures.length} failure(s)`,
    );
    exit(r.ok ? 0 : 1);
} else if (cmd === "verify") {
    try {
        const r = verify(root, {
            targets: positional.slice(1).map(asTarget),
            all: flag("--all"),
            changed: value("--changed"),
            timeoutSec: Number(value("--timeout") || 900),
        });
        if (r.runs.length === 0)
            console.log(
                `\nverify: no invariant test commands in ${r.contracts} selected contract(s)`,
            );
        else
            console.log(
                `\nverify ${r.failed ? "FAIL" : "PASS"}: ${r.runs.length - r.failed}/${r.runs.length} command(s) exited 0`,
            );
        exit(r.failed ? 1 : 0);
    } catch (e) {
        console.error(`anc verify: ${e.message}`);
        exit(1);
    }
} else if (cmd === "stats") {
    const s = stats(root);
    if (flag("--json")) console.log(JSON.stringify(s, null, 2));
    else for (const [k, v] of Object.entries(s)) console.log(`${k.padEnd(26)} ${v}`);
} else if (cmd === "init") {
    const dirs = flag("--all")
        ? [...workspacePackages(root).values()].map((p) => p.dir)
        : [positional[1] ? resolve(positional[1]) : process.cwd()];
    let created = 0;
    for (const d of dirs) {
        const dest = writeScaffold(root, d);
        if (dest) {
            created++;
            console.log(
                `created ${join(dirname(dest).replace(`${root}/`, ""), "CONTEXT.agent.yaml")}`,
            );
        }
    }
    console.log(
        `anc init: ${created} created, ${dirs.length - created} already had a contract. Fill in the placeholders, then run anc check.`,
    );
} else {
    console.error(`anc: unknown command "${cmd}"\n\n${HELP}`);
    exit(1);
}
