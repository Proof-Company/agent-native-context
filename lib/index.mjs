// ═══════════════════════════════════════════════════════════════════════════
// Agent-Native Context (ANC) — library. One engine; the CLI (bin/anc.mjs), the hooks and the
// repo wrappers all call these functions. Importing this module has no side effects.
//
// A contract is a CONTEXT.agent.yaml beside a package. This library:
//   • finds contracts and resolves the nearest one for a path (or a package name),
//   • validates them against the JSON Schema,
//   • checks dependency parity with package.json in both directions (workspace packages only),
//   • detects cycles in the workspace package graph,
//   • checks that every invariant's `test` command points at files and npm scripts that exist and is
//     not a tautology, and that scaffold placeholders were replaced,
//   • runs invariant test commands (`verify`), and counts what the contracts contain (`stats`).
// It reads manifests and YAML. It does not parse source code or follow imports.
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

export const CONTEXT_FILE = "CONTEXT.agent.yaml";
export const BUNDLED_SCHEMA = resolve(HERE, "../schemas/context-agent.schema.json");
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".vercel",
    "coverage",
    ".selftest-anc-tmp",
]);

// Text `anc init` writes. `check` rejects a contract that still carries it.
export const PLACEHOLDER_RULE = "State the primary system invariant that must never be broken";
export const PLACEHOLDER_PURPOSE_SUFFIX = "operational responsibility";
export const PLACEHOLDER_AUTHORITY = "Describe an action that needs human sign-off in this module";

let _yaml;
let _Ajv;
function yaml() {
    if (!_yaml) _yaml = require_("yaml");
    return _yaml;
}
function ajvClass() {
    if (!_Ajv) _Ajv = require_("ajv");
    return _Ajv.default || _Ajv;
}
export function parseYaml(text) {
    return yaml().parse(text);
}
export function stringifyYaml(value) {
    return yaml().stringify(value);
}

// ── Workspace discovery ────────────────────────────────────────────────────
export function findWorkspaceRoot(startDir = process.cwd()) {
    let current = resolve(startDir);
    let fallback = null;
    while (current !== dirname(current)) {
        if (
            existsSync(join(current, "pnpm-workspace.yaml")) ||
            existsSync(join(current, "turbo.json"))
        )
            return current;
        const pj = join(current, "package.json");
        if (existsSync(pj)) {
            try {
                if (JSON.parse(readFileSync(pj, "utf8")).workspaces) return current;
            } catch {
                /* catch-ok: invalid package.json */
            }
            if (!fallback) fallback = current;
        }
        if (existsSync(join(current, ".git"))) return fallback || current;
        current = dirname(current);
    }
    return fallback || resolve(startDir);
}

/** A directory holding a package.json with `workspaces` is the root of its own workspace. */
function isNestedWorkspaceRoot(dir) {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return false;
    try {
        return Boolean(JSON.parse(readFileSync(pj, "utf8")).workspaces);
    } catch {
        return false;
    }
}

/** Visit every file under root, skipping build/vendor dirs and any nested workspace (e.g. an example repo). */
function walk(dir, visit) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (!isNestedWorkspaceRoot(full)) walk(full, visit);
        } else visit(full, e.name);
    }
}

export function findContextFiles(root) {
    const out = [];
    walk(root, (full, name) => {
        if (name === CONTEXT_FILE) out.push(full);
    });
    return out.sort();
}

/** Every package.json under root except root's own: name → { dir, dependencies, devDependencies, peerDependencies, scripts } */
export function workspacePackages(root) {
    const map = new Map();
    walk(root, (full, name) => {
        if (name !== "package.json" || dirname(full) === resolve(root)) return;
        try {
            const pkg = JSON.parse(readFileSync(full, "utf8"));
            if (!pkg.name || map.has(pkg.name)) return;
            map.set(pkg.name, {
                dir: dirname(full),
                dependencies: Object.keys(pkg.dependencies || {}),
                devDependencies: Object.keys(pkg.devDependencies || {}),
                peerDependencies: Object.keys(pkg.peerDependencies || {}),
                scripts: pkg.scripts || {},
            });
        } catch {
            /* catch-ok: unparseable workspace package.json */
        }
    });
    return map;
}

export const shortName = (name) => String(name).replace(/^@[^/]+\//, "");

// ── Resolution ─────────────────────────────────────────────────────────────
/** Nearest CONTEXT.agent.yaml at or above `target` (a file or directory), never above root. */
export function findNearestContext(root, target) {
    const absRoot = resolve(root);
    let current = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
    if (existsSync(current) && statSync(current).isFile()) current = dirname(current);
    else if (!existsSync(current) && /\.[a-z0-9]+$/i.test(basename(current)))
        current = dirname(current);
    while (current === absRoot || current.startsWith(absRoot + sep)) {
        const candidate = join(current, CONTEXT_FILE);
        if (existsSync(candidate)) return candidate;
        if (current === absRoot) break;
        current = dirname(current);
    }
    return null;
}

export function findContextByName(root, name, files = findContextFiles(root)) {
    const clean = shortName(name);
    for (const file of files) {
        try {
            const doc = parseYaml(readFileSync(file, "utf8"));
            if (
                doc?.module &&
                (doc.module.name === clean ||
                    doc.module.name === name ||
                    doc.module.package === name)
            )
                return file;
        } catch {
            /* catch-ok: unparseable context yaml */
        }
    }
    return null;
}

/** { file (root-relative), abs, doc } for a path or package/module name, or null. */
export function resolveContext(root, target) {
    let file = findNearestContext(root, target);
    if (!file && (target.startsWith("@") || !/[\\/]/.test(target)))
        file = findContextByName(root, target);
    if (!file) return null;
    return { file: relative(root, file), abs: file, doc: parseYaml(readFileSync(file, "utf8")) };
}

// ── Schema ─────────────────────────────────────────────────────────────────
/** The workspace's own schema at <root>/schemas/ when present (it may be stricter), else the bundled one. */
export function schemaPathFor(root) {
    const local = join(root, "schemas", "context-agent.schema.json");
    return existsSync(local) ? local : BUNDLED_SCHEMA;
}

export function compileSchema(schemaPath) {
    const Ajv = ajvClass();
    const ajv = new Ajv({ strict: false, allErrors: true });
    return ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
}

export function validateContextFile(root, file, validate) {
    const rel = relative(root, file);
    let doc;
    try {
        doc = parseYaml(readFileSync(file, "utf8"));
    } catch (e) {
        return { path: rel, abs: file, ok: false, errors: [`YAML parse error: ${e.message}`] };
    }
    if (doc === null || doc === undefined)
        return { path: rel, abs: file, ok: false, errors: ["empty document"] };
    if (!validate(doc)) {
        return {
            path: rel,
            abs: file,
            ok: false,
            doc,
            errors: validate.errors.map((e) => `${e.instancePath || "/"}: ${e.message}`),
        };
    }
    return { path: rel, abs: file, ok: true, doc };
}

// ── Authority & placeholders ───────────────────────────────────────────────
export function checkAuthority(results) {
    const failures = [];
    for (const r of results) {
        if (!r.ok) continue;
        const a = r.doc.authority;
        if (
            !a ||
            !Array.isArray(a.autonomous) ||
            a.autonomous.length === 0 ||
            !Array.isArray(a.founder_approval) ||
            a.founder_approval.length === 0
        )
            failures.push(
                `${r.path}: authority.autonomous and authority.founder_approval must both list at least one action`,
            );
    }
    return failures;
}

export function checkPlaceholders(results) {
    const failures = [];
    for (const r of results) {
        if (!r.ok) continue;
        const d = r.doc;
        if (
            typeof d.module?.purpose === "string" &&
            d.module.purpose.endsWith(PLACEHOLDER_PURPOSE_SUFFIX) &&
            d.module.purpose.startsWith("Module ")
        )
            failures.push(`${r.path}: module.purpose is still the \`anc init\` placeholder`);
        for (const inv of d.invariants || [])
            if (inv.rule === PLACEHOLDER_RULE)
                failures.push(`${r.path} ${inv.id}: rule is still the \`anc init\` placeholder`);
        for (const a of d.authority?.founder_approval || [])
            if (a === PLACEHOLDER_AUTHORITY)
                failures.push(
                    `${r.path}: authority.founder_approval is still the \`anc init\` placeholder`,
                );
    }
    return failures;
}

// ── Dependency parity (manifest ⇄ contract), workspace packages only ───────
/**
 * Forward: every `dependencies.reads_from` entry with `via: import` is declared in package.json
 * (dependencies or peerDependencies). Reverse: every workspace package in dependencies/peerDependencies
 * appears in reads_from or writes_to. Contracts whose directory holds no package.json are skipped.
 */
export function checkDependencyParity(root, results, packages = workspacePackages(root)) {
    const failures = [];
    const byDir = new Map([...packages].map(([name, p]) => [p.dir, { name, ...p }]));
    // short name → workspace package names, so "core" means the workspace's @acme/core, never @capacitor/core
    const workspaceByShort = new Map();
    for (const name of packages.keys()) {
        const k = shortName(name);
        workspaceByShort.set(k, [...(workspaceByShort.get(k) || []), name]);
    }
    let checked = 0;
    for (const r of results) {
        if (!r.ok) continue;
        const pkg = byDir.get(dirname(r.abs));
        if (!pkg) continue;
        checked++;
        const runtime = [...pkg.dependencies, ...pkg.peerDependencies];
        const reads = r.doc.dependencies?.reads_from || [];
        const writes = r.doc.dependencies?.writes_to || [];
        const declared = (module) => {
            const m = String(module);
            if (m.startsWith("@")) return runtime.includes(m);
            const ws = workspaceByShort.get(m);
            return ws ? ws.some((n) => runtime.includes(n)) : runtime.includes(m);
        };
        for (const d of reads) {
            if (d.via === "import" && !declared(d.module))
                failures.push(
                    `${r.path}: reads_from "${d.module}" (via import) is not in ${relative(root, pkg.dir)}/package.json dependencies`,
                );
        }
        // what each listed entry can stand for: a scoped name means exactly that package; a bare name means
        // the workspace package(s) with that short name (so "@other/money" never covers "@example/money")
        const covers = new Set();
        for (const d of [...reads, ...writes]) {
            const m = String(d.module);
            if (m.startsWith("@")) covers.add(m);
            else for (const n of workspaceByShort.get(m) || []) covers.add(n);
        }
        for (const dep of runtime) {
            if (packages.has(dep) && !covers.has(dep))
                failures.push(
                    `${r.path}: package.json depends on workspace package ${dep} but the contract lists it in neither reads_from nor writes_to`,
                );
        }
    }
    return { failures, checked };
}

// ── Workspace cycles ───────────────────────────────────────────────────────
/** Cycles in the workspace package graph (dependencies + devDependencies + peerDependencies). */
export function findWorkspaceCycles(packages) {
    const color = new Map();
    const seen = new Set();
    const cycles = [];
    const visit = (name, stack) => {
        color.set(name, 1);
        stack.push(name);
        const p = packages.get(name);
        for (const dep of [...p.dependencies, ...p.devDependencies, ...p.peerDependencies]) {
            if (!packages.has(dep)) continue;
            if (color.get(dep) === 1) {
                const cyc = stack.slice(stack.indexOf(dep));
                const start = cyc.indexOf([...cyc].sort()[0]);
                const norm = [...cyc.slice(start), ...cyc.slice(0, start)];
                const key = norm.join(" -> ");
                if (!seen.has(key)) {
                    seen.add(key);
                    cycles.push([...norm, norm[0]]);
                }
            } else if (!color.get(dep)) visit(dep, stack);
        }
        stack.pop();
        color.set(name, 2);
    };
    for (const name of [...packages.keys()].sort()) if (!color.get(name)) visit(name, []);
    return cycles;
}

// ── Invariant oracle integrity ─────────────────────────────────────────────
const TAUTOLOGY =
    /^(true|:|exit\s+0|echo\b[^|;&]*)$|^node\s+-e\s+['"]?\s*process\.exit\(\s*0\s*\)\s*;?\s*['"]?$/;
// A command whose last step swallows the exit status (`… || true`, `…; exit 0`) cannot fail either.
const MASKED = /(\|\||;)\s*(true|:|exit\s+0|echo\b[^|;&]*)\s*$/;
const INTERPRETERS = new Set([
    "node",
    "tsx",
    "bash",
    "sh",
    "zsh",
    "python",
    "python3",
    "deno",
    "bun",
]);

function unquote(s) {
    return s.replace(/^["']|["']$/g, "");
}

function scriptsAt(root, relDir, packages) {
    const pj = join(root, relDir, "package.json");
    if (existsSync(pj)) {
        try {
            return JSON.parse(readFileSync(pj, "utf8")).scripts || {};
        } catch {
            /* catch-ok: unparseable package.json scripts */
        }
    }
    const byName = packages.get(relDir);
    return byName ? byName.scripts : null;
}

/** Problems with one test command, judged from the workspace root (where `anc verify` runs it). */
export function oracleProblems(root, command, packages = workspacePackages(root)) {
    const problems = [];
    const cmd = String(command).trim();
    const steps = cmd
        .split(/&&|;/)
        .map((x) => x.trim())
        .filter(Boolean);
    if (TAUTOLOGY.test(cmd) || (steps.length > 1 && steps.every((x) => TAUTOLOGY.test(x))))
        problems.push(`tautological test command \`${cmd}\``);
    else if (MASKED.test(cmd))
        problems.push(
            `test command \`${cmd}\` ends by discarding its exit status, so it cannot fail`,
        );
    let cwd = ".";
    for (const segment of cmd
        .split(/&&|\|\||;/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const tokens = segment.split(/\s+/).map(unquote);
        if (tokens[0] === "cd" && tokens[1]) {
            cwd = join(cwd, tokens[1]);
            if (!existsSync(join(root, cwd)))
                problems.push(`\`cd ${tokens[1]}\`: directory does not exist`);
            continue;
        }
        // a bare script file handed to an interpreter (`node check.mjs`) must exist too
        const head = tokens[0] === "npx" ? tokens[1] : tokens[0];
        if (INTERPRETERS.has(head)) {
            const file = tokens.slice(tokens.indexOf(head) + 1).find((t) => !t.startsWith("-"));
            if (
                file &&
                !file.includes("/") &&
                /\.(m?[jt]sx?|cjs|sh|py)$/.test(file) &&
                !existsSync(join(root, cwd, file))
            )
                problems.push(
                    `script \`${file}\` does not exist (relative to ${cwd === "." ? "the workspace root" : cwd})`,
                );
        }
        for (const t of tokens) {
            if (
                !t.includes("/") ||
                t.startsWith("-") ||
                t.startsWith("@") ||
                t.includes("://") ||
                /[*?$`=<>(){}]/.test(t)
            )
                continue;
            if (!existsSync(join(root, cwd, t)))
                problems.push(
                    `path \`${t}\` does not exist (relative to ${cwd === "." ? "the workspace root" : cwd})`,
                );
        }
        if (tokens[0] === "npm") {
            let pkgDir = cwd;
            const pre = tokens.indexOf("--prefix");
            if (pre !== -1 && tokens[pre + 1]) pkgDir = join(cwd, tokens[pre + 1]);
            const w = tokens.findIndex((t) => t === "-w" || t === "--workspace");
            if (w !== -1 && tokens[w + 1]) pkgDir = tokens[w + 1];
            const wEq = tokens.find((t) => t.startsWith("--workspace="));
            if (wEq) pkgDir = wEq.split("=")[1];
            const runIdx = tokens.findIndex((t) => t === "run" || t === "run-script");
            const script =
                runIdx !== -1
                    ? tokens.slice(runIdx + 1).find((t) => !t.startsWith("-"))
                    : tokens[1] === "test"
                      ? "test"
                      : null;
            if (script) {
                const scripts = scriptsAt(root, pkgDir, packages);
                if (!scripts?.[script])
                    problems.push(
                        `npm script \`${script}\` is not defined in ${pkgDir === "." ? "the root" : pkgDir} package.json`,
                    );
            }
        }
    }
    return problems;
}

export function checkOracles(root, results, packages = workspacePackages(root)) {
    const failures = [];
    let commands = 0;
    for (const r of results) {
        if (!r.ok) continue;
        for (const inv of r.doc.invariants || []) {
            if (!inv.test) continue;
            commands++;
            for (const p of oracleProblems(root, inv.test, packages))
                failures.push(`${r.path} ${inv.id}: ${p}`);
        }
    }
    return { failures, commands };
}

// ── Formatting (what an agent sees) ────────────────────────────────────────
/** Markdown for an agent. Self-reported health fields are deliberately not shown. */
export function formatContext(res) {
    const { file, doc } = res;
    const m = doc.module || {};
    const a = doc.authority || {};
    const b = doc.blast_radius || {};
    const deps = doc.dependencies || {};
    const out = [`# ANC contract: ${m.name || "unknown"} (${file})`];
    if (m.purpose) out.push(`Purpose: ${m.purpose}`);
    const invs = doc.invariants || [];
    if (invs.length) {
        out.push(
            "",
            "## Invariants — do not break these; run each test before you call the work done",
        );
        for (const inv of invs) {
            out.push(`- [${inv.id}] ${inv.rule}`);
            out.push(
                inv.test ? `  test: \`${inv.test}\`` : "  test: none (not mechanically checked)",
            );
        }
    }
    out.push("", "## Authority");
    if (a.autonomous?.length)
        out.push("You may, without asking:", ...a.autonomous.map((x) => `- ${x}`));
    if (a.founder_approval?.length)
        out.push("Stop and get sign-off before you:", ...a.founder_approval.map((x) => `- ${x}`));
    if (a.notes) out.push(`Note: ${a.notes}`);
    const reads = (deps.reads_from || []).map((d) => `${d.module} (${d.via})`);
    const writes = (deps.writes_to || []).map((d) => `${d.module} (${d.via})`);
    if (reads.length || writes.length) {
        out.push("", "## Dependencies");
        if (reads.length) out.push(`Reads from: ${reads.join(", ")}`);
        if (writes.length) out.push(`Writes to: ${writes.join(", ")}`);
    }
    if (b.level) {
        out.push("", `## Blast radius: ${String(b.level).toUpperCase()}`);
        if (b.data_impact) out.push(b.data_impact);
        if (b.downstream?.length) out.push(`Downstream: ${b.downstream.join(", ")}`);
    }
    return out.join("\n");
}

// ── Stats (what the contracts contain) ─────────────────────────────────────
const BROAD_SCRIPTS = new Set(["build", "test", "lint", "typecheck", "type-check"]);
const SCRIPT_FILE = /\.(m?[jt]sx?|cjs|sh|py)$/;
const CONFIG_FILE = /(^|\/)(tsconfig[^/]*|[^/]*\.config\.(m?[jt]s|cjs)|package\.json)$/;

/**
 * "targeted" when the test names a specific script or test file (not a config file), runs a named
 * npm script other than build/test/lint/typecheck, or runs inline code (`node -e`); otherwise "broad":
 * a whole package's or directory's tests, a typecheck, a lint, or a build — evidence that the package
 * still passes, not that this invariant holds.
 */
export function classifyOracle(command) {
    const cmd = String(command).trim();
    for (const segment of cmd.split(/&&|\|\||;/).map((x) => x.trim())) {
        const tokens = segment.split(/\s+/).map(unquote);
        if (tokens.some((t) => SCRIPT_FILE.test(t) && !CONFIG_FILE.test(t) && !t.startsWith("-")))
            return "targeted";
        if (/^(node|npx tsx|tsx)\s+-e\b/.test(segment)) return "targeted";
        if (tokens[0] === "npm") {
            const i = tokens.findIndex((t) => t === "run" || t === "run-script");
            const script = i !== -1 ? tokens.slice(i + 1).find((t) => !t.startsWith("-")) : null;
            if (script && !BROAD_SCRIPTS.has(script)) return "targeted";
        }
    }
    return "broad";
}

/** Counts over every contract under root; see classifyOracle for targeted vs broad tests. */
export function stats(root) {
    const files = findContextFiles(root);
    const s = {
        contracts: files.length,
        invariants: 0,
        invariants_with_test: 0,
        invariants_without_test: 0,
        targeted_oracles: 0,
        broad_oracles: 0,
        workspace_cycles: 0,
    };
    for (const f of files) {
        let doc;
        try {
            doc = parseYaml(readFileSync(f, "utf8"));
        } catch {
            continue;
        }
        for (const inv of doc?.invariants || []) {
            s.invariants++;
            const t = typeof inv.test === "string" ? inv.test.trim() : "";
            if (!t) {
                s.invariants_without_test++;
                continue;
            }
            s.invariants_with_test++;
            if (classifyOracle(t) === "targeted") s.targeted_oracles++;
            else s.broad_oracles++;
        }
    }
    s.workspace_cycles = findWorkspaceCycles(workspacePackages(root)).length;
    return s;
}

// ── Verify (run the invariant tests) ───────────────────────────────────────
function changedContracts(root, ref) {
    const run = (args) => {
        const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
        // fail closed: an unknown ref or a shallow clone must not turn into "nothing changed"
        if (r.status !== 0)
            throw new Error(
                `git ${args.join(" ")} failed: ${(r.stderr || "").trim().split("\n")[0]}`,
            );
        return r.stdout;
    };
    const names =
        `${run(["diff", "--name-only", `${ref}...HEAD`])}\n${run(["diff", "--name-only", "HEAD"])}\n${run(["ls-files", "--others", "--exclude-standard"])}`
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
    const files = new Set();
    for (const n of names) {
        const c = findNearestContext(root, n);
        if (c) files.add(c);
    }
    return [...files];
}

/**
 * Run the `test` command of every invariant in the selected contracts, from the workspace root.
 * Identical commands run once. Returns { runs: [{ command, invariants, status, ms }], failed }.
 */
export function verify(
    root,
    {
        targets = [],
        all = false,
        changed = null,
        timeoutSec = 900,
        stdio = "inherit",
        log = console.log,
    } = {},
) {
    if (!all && !changed && targets.length === 0)
        throw new Error("name at least one target, or pass --all or --changed <git-ref>");
    let files = [];
    if (all) {
        files = findContextFiles(root);
        if (files.length === 0)
            throw new Error(
                `no ${CONTEXT_FILE} files under ${root} — wrong --root or working directory?`,
            );
    } else if (changed) files = changedContracts(root, changed);
    for (const t of targets) {
        const r = resolveContext(root, t);
        if (!r) throw new Error(`no ${CONTEXT_FILE} found for "${t}"`);
        files.push(r.abs);
    }
    const byCommand = new Map();
    for (const f of [...new Set(files)]) {
        const doc = parseYaml(readFileSync(f, "utf8"));
        for (const inv of doc?.invariants || []) {
            if (!inv.test) continue;
            const key = inv.test.trim();
            if (!byCommand.has(key)) byCommand.set(key, []);
            byCommand.get(key).push(`${relative(root, f)}#${inv.id}`);
        }
    }
    const runs = [];
    for (const [command, invariants] of byCommand) {
        log(`\n▶ ${command}\n  for ${invariants.join(", ")}`);
        const t0 = Date.now();
        const r = spawnSync(command, {
            cwd: root,
            shell: true,
            stdio,
            timeout: timeoutSec * 1000,
            encoding: "utf8",
        });
        const status = r.error ? `error: ${r.error.code || r.error.message}` : r.status;
        runs.push({ command, invariants, status, ms: Date.now() - t0 });
        log(
            `  ${status === 0 ? "✓ exit 0" : `✗ ${typeof status === "number" ? `exit ${status}` : status}`} (${Date.now() - t0} ms)`,
        );
    }
    return { runs, failed: runs.filter((r) => r.status !== 0).length, contracts: files.length };
}

// ── Check (the gate) ───────────────────────────────────────────────────────
/**
 * Schema, authority, placeholders, dependency parity, workspace cycles, oracle integrity.
 * Returns { ok, failures: string[], lines: string[] } — `lines` is the human report.
 */
export function check(root, { schemaPath = schemaPathFor(root) } = {}) {
    const lines = [];
    const failures = [];
    const files = findContextFiles(root);
    if (files.length === 0) {
        failures.push(`no ${CONTEXT_FILE} files found under ${root}`);
        return { ok: false, failures, lines: [`FAIL ${failures[0]}`] };
    }
    const validate = compileSchema(schemaPath);
    const results = files.map((f) => validateContextFile(root, f, validate));
    for (const r of results) {
        if (r.ok) lines.push(`  ok: ${r.path}`);
        else {
            failures.push(`${r.path}: schema`);
            lines.push(`  FAIL schema: ${r.path}`, ...r.errors.map((e) => `    ${e}`));
        }
    }
    const section = (name, list, passNote) => {
        for (const f of list) lines.push(`  FAIL ${name}: ${f}`);
        failures.push(...list);
        lines.push(
            list.length
                ? `${name} check FAIL (${list.length})`
                : `${name} check PASS${passNote ? ` (${passNote})` : ""}`,
        );
    };
    lines.push(
        `schema: ${results.filter((r) => r.ok).length}/${results.length} contract(s) valid against ${relative(root, schemaPath) || schemaPath}`,
    );
    section("authority", checkAuthority(results));
    section("placeholder", checkPlaceholders(results));
    const packages = workspacePackages(root);
    const parity = checkDependencyParity(root, results, packages);
    for (const f of parity.failures) lines.push(`  FAIL deps: ${f}`);
    failures.push(...parity.failures);
    lines.push(
        parity.failures.length
            ? `dependency cross-check FAIL (${parity.failures.length})`
            : `dependency cross-check PASS (${parity.checked} contract(s) beside a package.json, both directions)`,
    );
    const cycles = findWorkspaceCycles(packages);
    section(
        "cycle",
        cycles.map((c) => `workspace dependency cycle: ${c.join(" -> ")}`),
        `${packages.size} workspace package(s)`,
    );
    const oracles = checkOracles(root, results, packages);
    section(
        "oracle",
        oracles.failures,
        `${oracles.commands} test command(s) point at existing files and scripts`,
    );
    return { ok: failures.length === 0, failures, lines };
}

// ── Scaffold ───────────────────────────────────────────────────────────────
/** A contract skeleton for a package directory. It fails `check` until its placeholders are replaced. */
export function scaffold(root, dir, packages = workspacePackages(root)) {
    const abs = resolve(dir);
    let name = basename(abs);
    let pkgName = null;
    let reads = [];
    const pj = join(abs, "package.json");
    if (existsSync(pj)) {
        try {
            const pkg = JSON.parse(readFileSync(pj, "utf8"));
            if (pkg.name) {
                pkgName = pkg.name;
                name = shortName(pkg.name);
            }
            reads = [
                ...Object.keys(pkg.dependencies || {}),
                ...Object.keys(pkg.peerDependencies || {}),
            ]
                .filter((d) => packages.has(d))
                .map((d) => ({ module: shortName(d), via: "import" }));
        } catch {
            /* catch-ok: unparseable package.json in scaffold */
        }
    }
    const today = new Date().toISOString().slice(0, 10);
    return {
        module: {
            name,
            package: pkgName,
            purpose: `Module ${name} ${PLACEHOLDER_PURPOSE_SUFFIX}`,
            domain: "platform",
            path: `${relative(root, abs) || "."}/`,
        },
        dependencies: { reads_from: reads, writes_to: [], shared_tables: [], last_verified: today },
        invariants: [
            {
                id: `inv-${name}-01`,
                rule: PLACEHOLDER_RULE,
                type: "integrity",
                enforced_by: [],
                test: null,
            },
        ],
        authority: {
            autonomous: ["Change code covered by this module's tests"],
            founder_approval: [PLACEHOLDER_AUTHORITY],
            notes: null,
        },
        blast_radius: {
            level: "medium",
            upstream: reads.map((r) => r.module),
            downstream: [],
            data_impact: "Describe what breaks if this module breaks.",
        },
    };
}

export function writeScaffold(root, dir) {
    const dest = join(resolve(dir), CONTEXT_FILE);
    if (existsSync(dest)) return null;
    writeFileSync(dest, stringifyYaml(scaffold(root, dir)));
    return dest;
}

// ── Claude Code hook ───────────────────────────────────────────────────────
/**
 * Given a Claude Code PreToolUse payload, return the JSON to print (or "" to stay silent).
 * Context reaches the model only through hookSpecificOutput.additionalContext; plain stdout from a
 * PreToolUse hook is not shown to it. Each module's contract is sent at most once per 30 minutes per
 * session (so it returns after a context compaction).
 */
export function hookOutput(
    payload,
    { root = null, stateDir = join(tmpdir(), "anc-context"), resendMinutes = 30 } = {},
) {
    let input;
    try {
        input = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
        return "";
    }
    const ti = input?.tool_input || {};
    const target = ti.file_path || ti.notebook_path || ti.path;
    if (!target || typeof target !== "string") return "";
    const base = root || findWorkspaceRoot(input.cwd || dirname(resolve(target)));
    const targetPath = isAbsolute(target) ? target : resolve(input.cwd || base, target);
    const res = resolveContext(base, targetPath);
    if (!res) return "";
    const session = String(input.session_id || "no-session").replace(/[^\w.-]/g, "_");
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, `${session}.json`);
    let seen = {};
    try {
        seen = JSON.parse(readFileSync(stateFile, "utf8"));
        if (Array.isArray(seen)) seen = {};
    } catch {
        /* catch-ok: unreadable hook state file */
    }
    const key = resolve(base, res.file);
    const now = Date.now();
    // Re-send after resendMinutes so a contract lost to context compaction comes back on a later edit.
    if (seen[key] && now - seen[key] < resendMinutes * 60_000) return "";
    writeFileSync(stateFile, JSON.stringify({ ...seen, [key]: now }));
    let context = `Agent-Native Context — the contract for the module you are about to change (shown at most once per module every 30 minutes in a session):\n\n${formatContext(res)}`;
    try {
        if (/\.[cm]?[jt]sx?$/.test(targetPath) && existsSync(targetPath)) {
            const trace = traceFile(base, targetPath, { depth: 1 });
            context += `\n\nCode Topology & Wire Trace (runtime connectors):\n${formatTrace(trace)}`;
        }
    } catch {
        // fail-safe: wire trace is additive
    }
    return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
    });
}

import {
    detectRuntime,
    extractImportMap,
    extractRenderedComponents,
    extractWires,
    formatTrace,
    traceBatch,
    traceFile,
} from "./trace.mjs";

export {
    detectRuntime,
    extractImportMap,
    extractRenderedComponents,
    extractWires,
    formatTrace,
    traceBatch,
    traceFile,
};
