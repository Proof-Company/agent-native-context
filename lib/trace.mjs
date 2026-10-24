// ═══════════════════════════════════════════════════════════════════════════
// Agent-Native Context (ANC) — Code Topology & Wire Tracer
//
// Extracts runtime execution context, rendered UI components, API routes,
// database queries (with tenant_id isolation audit), background events,
// and couples them with localized module invariants from CONTEXT.agent.yaml.
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveContext, stringifyYaml } from "./index.mjs";

const STANDARD_JSX_TAGS = new Set([
    "a",
    "abbr",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "base",
    "bdi",
    "bdo",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "datalist",
    "dd",
    "del",
    "details",
    "dfn",
    "dialog",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "iframe",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "link",
    "main",
    "map",
    "mark",
    "meta",
    "meter",
    "nav",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "picture",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "script",
    "section",
    "select",
    "slot",
    "small",
    "source",
    "span",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "title",
    "tr",
    "track",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
    // SVG tags
    "svg",
    "path",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
    "text",
    "g",
    "defs",
    "clippath",
    "mask",
    "pattern",
    "lineargradient",
    "radialgradient",
    "stop",
    "use",
    // React built-ins
    "Fragment",
    "Suspense",
    "StrictMode",
]);

const REACT_CORE_HOOKS = new Set([
    "useState",
    "useEffect",
    "useCallback",
    "useMemo",
    "useRef",
    "useId",
    "useContext",
    "useLayoutEffect",
    "useTransition",
    "useDeferredValue",
    "useImperativeHandle",
    "useDebugValue",
    "useInsertionEffect",
    "useSyncExternalStore",
]);

export const PLATFORM_TABLES = new Set([
    "TABLE",
    "table",
    "ai_usage_logs",
    "app_data",
    "career_applications",
    "cron_executions",
    "permissions",
    "pricing_items",
    "pricing_rates",
    "pricing_regions",
    "pricing_tiers",
    "roles",
    "schema_migrations",
    "service_registry",
    "sms_delivery_logs",
    "state_lien_rules",
    "system_events",
    "tenants",
    "users",
]);

/**
 * Detect runtime execution context based on directives, paths, and code patterns.
 */
export function detectRuntime(code, relPath) {
    const norm = relPath.replace(/\\/g, "/");

    // Test suite
    if (/\.(test|spec)\.[a-z0-9]+$/i.test(norm) || norm.includes("/__tests__/")) {
        return "test-suite";
    }

    // Directives (top of file)
    const topLines = code.slice(0, 1000);
    if (/^\s*(["'])use client\1/m.test(topLines)) {
        return "client-component";
    }
    if (/^\s*(["'])use server\1/m.test(topLines)) {
        return "server-action";
    }

    // Next.js Route Handlers
    if (/\/app\/api\//.test(norm) || /\/api\/.*route\.[a-z0-9]+$/i.test(norm)) {
        return "route-handler";
    }
    if (
        /export\s+(?:async\s+)?(?:const|function)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(
            code,
        )
    ) {
        return "route-handler";
    }

    // Inngest background worker
    if (/\/inngest\//.test(norm) || /inngest\.createFunction\s*\(/.test(code)) {
        return "background-worker";
    }

    // Next.js App Router server components (pages, layouts, templates without "use client")
    if (/\/app\/.*(page|layout|template|loading|error|not-found)\.[a-z0-9]+$/i.test(norm)) {
        return "server-component";
    }

    // Components with JSX / TSX
    if (norm.endsWith(".tsx") || norm.endsWith(".jsx")) {
        return "server-component";
    }

    return "library-module";
}

/**
 * Extract imports map: identifier -> source string
 */
export function extractImportMap(code) {
    const imports = new Map();
    // Match: import ... from "..."
    const importRegex =
        /import\s+(?:(?:\*\s+as\s+([a-zA-Z0-9_$]+))|([a-zA-Z0-9_$]+)|(?:\{([^}]+)\}))(?:\s*,\s*(?:([a-zA-Z0-9_$]+)|\{([^}]+)\}))?\s+from\s+["']([^"']+)["']/g;
    for (const match of code.matchAll(importRegex)) {
        const source = match[6];
        if (match[1]) imports.set(match[1], source); // * as Foo
        if (match[2]) imports.set(match[2], source); // default Foo
        if (match[3]) {
            // { a, b as c }
            for (const item of match[3].split(",")) {
                const parts = item.trim().split(/\s+as\s+/);
                const name = (parts[1] || parts[0]).trim();
                if (name) imports.set(name, source);
            }
        }
        if (match[4]) imports.set(match[4], source);
        if (match[5]) {
            for (const item of match[5].split(",")) {
                const parts = item.trim().split(/\s+as\s+/);
                const name = (parts[1] || parts[0]).trim();
                if (name) imports.set(name, source);
            }
        }
    }

    // next/dynamic or React.lazy imports: nextDynamic(() => import("..."))
    const dynamicRegex =
        /(?:nextDynamic|lazy)\s*\(\s*\(\)\s*=>\s*import\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of code.matchAll(dynamicRegex)) {
        const source = match[1];
        const base = basename(source);
        imports.set(base, source);
    }

    return imports;
}

/**
 * Extract rendered JSX components and pair them with import origins.
 */
export function extractRenderedComponents(code, importMap) {
    const rendered = new Set();
    const tagRegex = /<([A-Z][a-zA-Z0-9_$]*)(?:\s|\/|>|\n)/g;
    for (const match of code.matchAll(tagRegex)) {
        const tag = match[1];
        if (!STANDARD_JSX_TAGS.has(tag)) {
            rendered.add(tag);
        }
    }

    const results = [];
    for (const tag of Array.from(rendered).sort()) {
        const origin = importMap.get(tag);
        results.push(origin ? `${tag} (from ${origin})` : tag);
    }
    return results;
}

/**
 * Extract wire connectors: API endpoints, DB queries, inngest events, and custom hooks.
 */
export function extractWires(code, relPath) {
    const apis = new Set();
    const tablesMap = new Map();
    const events = new Set();
    const hooks = new Set();

    // 1. Inbound route handler methods
    const routeMethodRegex =
        /export\s+(?:async\s+)?(?:const|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    const handledMethods = [];
    for (const match of code.matchAll(routeMethodRegex)) {
        handledMethods.push(match[1]);
    }
    if (handledMethods.length > 0) {
        // Derive API route path from file path
        let routePath = relPath.replace(/\\/g, "/");
        routePath = routePath
            .replace(/^.*\/app\/api\//, "/api/")
            .replace(/\/route\.[a-z0-9]+$/i, "");
        apis.add(`INBOUND: [${handledMethods.join(", ")}] ${routePath}`);
    }

    // 2. Outbound API endpoints (fetch, useQuery, axios, apiClient)
    const apiCallRegex =
        /(?:fetch|useAuthenticatedQuery|useAuthenticatedMutation|axios\.[a-z]+)\s*\(\s*(?:\[[^\]]*\],\s*)?["'`](\/api\/[a-zA-Z0-9_\-.${}/]+)["'`]/g;
    for (const match of code.matchAll(apiCallRegex)) {
        apis.add(`FETCH: ${match[1]}`);
    }

    // Generic string match for /api/...
    const genericApiRegex = /["'`](\/api\/[a-zA-Z0-9_\-.${}/]+)["'`]/g;
    for (const match of code.matchAll(genericApiRegex)) {
        const path = match[1];
        if (!path.includes(" ") && path.length > 6) {
            apis.add(`FETCH: ${path}`);
        }
    }

    // 3. Database tables (.from("table")) excluding Buffer.from / Array.from / storage.from
    const dbTableRegex = /(?<!Buffer|Array|storage)\.from\s*\(\s*["'`]?([a-zA-Z0-9_]+)["'`]?\s*\)/g;
    for (const match of code.matchAll(dbTableRegex)) {
        const table = match[1];
        if (!tablesMap.has(table)) {
            tablesMap.set(table, { table });
        }
    }

    // Tenant isolation check across the file
    const hasTenantCheck =
        /\.eq\s*\(\s*["']tenant_id["']/i.test(code) ||
        /(?:["']tenant_id["']|tenant_id)\s*:/i.test(code) ||
        /withTenantGuard\b/.test(code) ||
        /ctx\.tenant\b/.test(code) ||
        /tenantSlug\b/.test(code) ||
        /tenant_slug\b/.test(code);

    const isSystemRoute =
        relPath.includes("/app/api/admin/") ||
        relPath.includes("\\app\\api\\admin\\") ||
        relPath.includes("/app/api/organizations") ||
        relPath.includes("\\app\\api\\organizations\\") ||
        relPath.includes("/app/api/cron/") ||
        relPath.includes("\\app\\api\\cron\\") ||
        relPath.includes("/app/api/webhook") ||
        relPath.includes("\\app\\api\\webhook") ||
        relPath.includes("/app/api/inngest") ||
        relPath.includes("\\app\\api\\inngest\\");

    const tables = [];
    for (const item of tablesMap.values()) {
        const isGlobal = PLATFORM_TABLES.has(item.table);
        const isScoped = hasTenantCheck || isGlobal || isSystemRoute;
        tables.push({
            table: item.table,
            tenant_scoped: isScoped
                ? isGlobal
                    ? "exempt: global-platform-table"
                    : isSystemRoute
                      ? "exempt: system-route"
                      : true
                : "WARN: missing explicit tenant_id scoping in file",
        });
    }

    // 4. Inngest background events
    const inngestSendRegex = /inngest\.send\s*\(\s*\[?\s*\{\s*name:\s*["']([^"']+)["']/g;
    for (const match of code.matchAll(inngestSendRegex)) {
        events.add(`EMIT: ${match[1]}`);
    }
    const inngestListenRegex = /event:\s*["']([a-zA-Z0-9_\-./]+)["']/g;
    for (const match of code.matchAll(inngestListenRegex)) {
        if (code.includes("createFunction")) {
            events.add(`LISTEN: ${match[1]}`);
        }
    }

    // 5. Custom React hooks
    const hookRegex = /\b(use[A-Z][a-zA-Z0-9_$]*)\s*\(/g;
    for (const match of code.matchAll(hookRegex)) {
        const hook = match[1];
        if (!REACT_CORE_HOOKS.has(hook)) {
            hooks.add(hook);
        }
    }

    return {
        apis: Array.from(apis).sort(),
        tables: tables.sort((a, b) => a.table.localeCompare(b.table)),
        events: Array.from(events).sort(),
        hooks: Array.from(hooks).sort(),
    };
}

/**
 * Main trace engine entry point.
 */
export function traceFile(root, targetInput, options = {}) {
    const absRoot = resolve(root);
    const absTarget = isAbsolute(targetInput)
        ? resolve(targetInput)
        : resolve(absRoot, targetInput);

    if (!existsSync(absTarget)) {
        throw new Error(`Target file not found: ${targetInput}`);
    }
    if (!statSync(absTarget).isFile()) {
        throw new Error(`Target is not a file: ${targetInput}`);
    }

    const relPath = relative(absRoot, absTarget).replace(/\\/g, "/");
    const code = readFileSync(absTarget, "utf8");

    // 1. Detect runtime
    const runtime = detectRuntime(code, relPath);

    // 2. Extract imports and rendered components
    const importMap = extractImportMap(code);
    const renders = extractRenderedComponents(code, importMap);

    // 3. Extract wires
    const wires = extractWires(code, relPath);

    // Optional transitive wires (depth > 0)
    let transitiveWires = null;
    const depth = options.depth || 0;
    if (depth > 0) {
        const transApis = new Set();
        const transTablesMap = new Map();
        const transEvents = new Set();
        const transHooks = new Set();

        const targetDir = dirname(absTarget);
        for (const importPath of importMap.values()) {
            if (importPath.startsWith("./") || importPath.startsWith("../")) {
                const resolvedLocal = resolve(targetDir, importPath);
                const extensions = [
                    "",
                    ".ts",
                    ".tsx",
                    ".js",
                    ".jsx",
                    ".mjs",
                    "/index.ts",
                    "/index.tsx",
                ];
                let candidate = null;
                for (const ext of extensions) {
                    if (existsSync(resolvedLocal + ext) && statSync(resolvedLocal + ext).isFile()) {
                        candidate = resolvedLocal + ext;
                        break;
                    }
                }
                if (candidate) {
                    try {
                        const localCode = readFileSync(candidate, "utf8");
                        const localRel = relative(absRoot, candidate).replace(/\\/g, "/");
                        const localWires = extractWires(localCode, localRel);
                        for (const api of localWires.apis)
                            transApis.add(`${api} (via ${importPath})`);
                        for (const t of localWires.tables) {
                            if (!transTablesMap.has(t.table)) transTablesMap.set(t.table, t);
                        }
                        for (const ev of localWires.events)
                            transEvents.add(`${ev} (via ${importPath})`);
                        for (const h of localWires.hooks) transHooks.add(h);
                    } catch {
                        /* catch-ok */
                    }
                }
            }
        }

        if (
            transApis.size > 0 ||
            transTablesMap.size > 0 ||
            transEvents.size > 0 ||
            transHooks.size > 0
        ) {
            transitiveWires = {
                apis: Array.from(transApis).sort(),
                tables: Array.from(transTablesMap.values()).sort((a, b) =>
                    a.table.localeCompare(b.table),
                ),
                events: Array.from(transEvents).sort(),
                hooks: Array.from(transHooks).sort(),
            };
        }
    }

    // 4. Couple with nearest ANC contract
    const context = resolveContext(absRoot, absTarget);
    let moduleInfo = null;
    let invariants = [];
    let authority = null;
    let blastRadius = null;

    if (context?.doc) {
        const doc = context.doc;
        moduleInfo = {
            name: doc.module?.name || "unknown",
            package: doc.module?.package || "unknown",
            purpose: doc.module?.purpose || "",
        };
        if (Array.isArray(doc.invariants)) {
            invariants = doc.invariants.map((inv) => ({
                id: inv.id,
                rule: inv.rule,
                type: inv.type,
            }));
        }
        if (doc.authority) {
            authority = {
                founder_approval: doc.authority.founder_approval || [],
            };
        }
        if (doc.blast_radius) {
            blastRadius = {
                level: doc.blast_radius.level || "unknown",
                data_impact: doc.blast_radius.data_impact || "",
            };
        }
    }

    return {
        target: relPath,
        runtime,
        module: moduleInfo?.name || "standalone",
        purpose: moduleInfo?.purpose || "",
        renders,
        wires,
        transitive_wires: transitiveWires,
        invariants,
        authority,
        blast_radius: blastRadius,
    };
}

/**
 * Format trace result as clean, compact YAML for AI coding agents.
 */
export function formatTrace(traceResult) {
    const doc = {
        trace: {
            target: traceResult.target,
            runtime: traceResult.runtime,
            module: traceResult.module,
            purpose: traceResult.purpose || undefined,
        },
        renders: traceResult.renders.length > 0 ? traceResult.renders : undefined,
        wires: {
            apis: traceResult.wires.apis.length > 0 ? traceResult.wires.apis : undefined,
            tables: traceResult.wires.tables.length > 0 ? traceResult.wires.tables : undefined,
            events: traceResult.wires.events.length > 0 ? traceResult.wires.events : undefined,
            hooks: traceResult.wires.hooks.length > 0 ? traceResult.wires.hooks : undefined,
        },
        transitive_wires: traceResult.transitive_wires || undefined,
        invariants: traceResult.invariants.length > 0 ? traceResult.invariants : undefined,
        authority: traceResult.authority || undefined,
        blast_radius: traceResult.blast_radius || undefined,
    };

    // Remove empty wire keys
    if (!doc.wires.apis && !doc.wires.tables && !doc.wires.events && !doc.wires.hooks) {
        delete doc.wires;
    }

    return stringifyYaml(doc);
}

/**
 * Batch scan files across a directory or package and summarize architecture topology.
 */
export function traceBatch(root, targetDir, options = {}) {
    const absRoot = resolve(root);
    const absTargetDir = isAbsolute(targetDir) ? resolve(targetDir) : resolve(absRoot, targetDir);

    const results = [];
    const runtimes = {};
    const uniqueApis = new Set();
    const uniqueTables = new Set();
    const warnings = [];

    const SKIP = new Set([
        "node_modules",
        ".git",
        ".next",
        "out",
        "dist",
        "build",
        "coverage",
        ".turbo",
        "__tests__",
    ]);

    function walkDir(dir) {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (SKIP.has(e.name)) continue;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                walkDir(full);
            } else if (
                /\.(tsx|ts|jsx|js|mjs)$/i.test(e.name) &&
                !/\.(test|spec)\.[a-z0-9]+$/i.test(e.name) &&
                !e.name.endsWith(".d.ts")
            ) {
                try {
                    const trace = traceFile(absRoot, full, options);
                    results.push(trace);
                    runtimes[trace.runtime] = (runtimes[trace.runtime] || 0) + 1;
                    for (const api of trace.wires.apis) uniqueApis.add(api);
                    for (const t of trace.wires.tables) {
                        uniqueTables.add(t.table);
                        if (
                            typeof t.tenant_scoped === "string" &&
                            t.tenant_scoped.startsWith("WARN")
                        ) {
                            warnings.push(
                                `${trace.target}: table ${t.table} lacks tenant_id scoping`,
                            );
                        }
                    }
                } catch {
                    /* catch-ok */
                }
            }
        }
    }

    walkDir(absTargetDir);

    return {
        target_dir: relative(absRoot, absTargetDir).replace(/\\/g, "/") || ".",
        total_files_scanned: results.length,
        runtimes,
        unique_apis_count: uniqueApis.size,
        unique_tables_count: uniqueTables.size,
        warnings_count: warnings.length,
        warnings: warnings.slice(0, 10),
    };
}
