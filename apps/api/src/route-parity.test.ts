import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { testDeps } from "./test-helpers";
import { ROUTE_CLASSIFICATION } from "./route-parity";

/**
 * API <-> UI parity guard (audit R1).
 *
 * Every route the app registers must be accounted for:
 *   (a) referenced by the web client / widget / SPA sources — extracted
 *       below at method+path granularity — or
 *   (b) classified in route-parity.ts (WEBHOOK / API-ONLY + reason).
 * A route that is BOTH is a stale classification and also fails: when a
 * classified route gains a UI caller, its entry must be removed.
 *
 * Extraction is deliberately pragmatic and matched to this codebase's
 * call style:
 *   - apps/web/src/api.ts: `request(...)` / `requestText(...)` call
 *     sites; the HTTP method comes from the init object (default GET).
 *   - apps/web/src/widget.ts: its local `api(...)` helper, same rule.
 *   - apps/web/src/App.tsx + flows/FlowBuilder.tsx: path literals are
 *     browser navigations / hrefs / img srcs — counted as GET.
 * Template literals are normalized: each ${...} becomes a {} segment;
 * `${base}` prefixes are dropped; a trailing glued {} (a `${suffix}`
 * query artifact) and "{}{}" (conditional-query artifact) collapse.
 */

const WEB_SRC = join(import.meta.dir, "../../web/src");

function normalizeRoutePath(path: string): string {
  return path.replace(/:[^/]+/g, "{}").replace(/\{[^}]+\}/g, "{}");
}

/** Normalize a string/template literal's contents to a route path ("" when not a path). */
export function normalizeLiteralPath(raw: string): string {
  const parts = raw.split(/\$\{[^}]*\}/g);
  const start = parts.findIndex((p) => p.startsWith("/"));
  if (start === -1) return "";
  let path = parts[start]!;
  for (let i = start + 1; i < parts.length; i++) path += "{}" + parts[i]!;
  path = path.split("?")[0]!;
  while (path.endsWith("{}{}")) path = path.slice(0, -2);
  if (path.endsWith("{}") && path.length > 2 && path[path.length - 3] !== "/") {
    path = path.slice(0, -2);
  }
  return path;
}

/** Source slice from the "(" at openIdx to its matching ")" (quote-aware). */
function callSpan(source: string, openIdx: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return source.slice(openIdx);
}

/** Method+path references from `fnName(...)` call sites whose first arg is a path literal. */
function extractCallRefs(source: string, fnNames: string[]): Set<string> {
  const refs = new Set<string>();
  const nameRe = new RegExp(`\\b(?:${fnNames.join("|")})\\b`, "g");
  for (const match of source.matchAll(nameRe)) {
    let i = match.index + match[0].length;
    const skipWs = () => { while (i < source.length && /\s/.test(source[i]!)) i++; };
    skipWs();
    if (source[i] === "<") {
      // Generic arguments: walk to the matching ">".
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "<") depth++;
        else if (source[i] === ">") { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      skipWs();
    }
    if (source[i] !== "(") continue;
    const openIdx = i;
    i++;
    skipWs();
    const quote = source[i];
    if (quote !== "`" && quote !== '"' && quote !== "'") continue;
    let inner = "";
    i++;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") i++;
      if (i < source.length) { inner += source[i]; i++; }
    }
    const path = normalizeLiteralPath(inner);
    if (!path) continue;
    const span = callSpan(source, openIdx);
    const method = span.match(/method:\s*["'](GET|POST|PATCH|PUT|DELETE)["']/)?.[1] ?? "GET";
    refs.add(`${method} ${path}`);
  }
  return refs;
}

/** GET references from every path-shaped literal in a source file. */
function extractLiteralGetRefs(source: string): Set<string> {
  const refs = new Set<string>();
  for (const match of source.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)) {
    const inner = match[1] ?? match[2] ?? match[3] ?? "";
    const path = normalizeLiteralPath(inner);
    // A bare "/" literal in the SPA is the site root link, not the API's
    // identity root — it does not count as an API reference.
    if (path && path !== "/" && /^\/[A-Za-z0-9_./{}-]*$/.test(path)) refs.add(`GET ${path}`);
  }
  return refs;
}

/**
 * A route counts as referenced on an exact hit, or when a referenced
 * pattern's {} segments stand in for the route's concrete segments
 * (client literals parameterize ids AND channel names, while several
 * routes are registered per concrete channel).
 */
function isReferenced(route: string, referenced: Set<string>): boolean {
  if (referenced.has(route)) return true;
  const [method, path] = route.split(" ");
  const routeSegs = path!.split("/");
  for (const ref of referenced) {
    const [refMethod, refPath] = ref.split(" ");
    if (refMethod !== method) continue;
    const refSegs = refPath!.split("/");
    if (refSegs.length !== routeSegs.length) continue;
    if (refSegs.every((seg, i) => seg === "{}" || seg === routeSegs[i])) return true;
  }
  return false;
}

function webReferences(): Set<string> {
  const refs = new Set<string>();
  const apiTs = readFileSync(join(WEB_SRC, "api.ts"), "utf8");
  for (const r of extractCallRefs(apiTs, ["requestText", "request"])) refs.add(r);
  const widgetTs = readFileSync(join(WEB_SRC, "widget.ts"), "utf8");
  for (const r of extractCallRefs(widgetTs, ["api"])) refs.add(r);
  for (const file of ["App.tsx", join("flows", "FlowBuilder.tsx")]) {
    const src = readFileSync(join(WEB_SRC, file), "utf8");
    for (const r of extractLiteralGetRefs(src)) refs.add(r);
  }
  return refs;
}

function appRoutes(): Set<string> {
  const app = createApp(testDeps());
  const routes = new Set<string>();
  for (const r of app.routes as Array<{ method: string; path: string }>) {
    if (r.method === "ALL") continue;
    routes.add(`${r.method} ${normalizeRoutePath(r.path)}`);
  }
  return routes;
}

describe("API <-> UI parity guard (R1)", () => {
  const routes = appRoutes();
  const referenced = webReferences();
  const classified = new Set(Object.keys(ROUTE_CLASSIFICATION));

  test("every route is referenced by the web client OR classified", () => {
    const unaccounted = [...routes].filter((r) => !isReferenced(r, referenced) && !classified.has(r));
    expect(unaccounted).toEqual([]);
  });

  test("no route is both referenced and classified (stale classification)", () => {
    const both = [...routes].filter((r) => isReferenced(r, referenced) && classified.has(r));
    expect(both).toEqual([]);
  });

  test("every classification entry names a real route", () => {
    const stale = [...classified].filter((r) => !routes.has(r));
    expect(stale).toEqual([]);
  });

  test("every classification entry carries a class and a reason", () => {
    for (const [route, entry] of Object.entries(ROUTE_CLASSIFICATION)) {
      expect(entry.class, route).toMatch(/^(WEBHOOK|API-ONLY)$/);
      expect(entry.reason.length, route).toBeGreaterThan(10);
    }
  });
});
