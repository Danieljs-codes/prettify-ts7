/**
 * Hover benchmark for the TypeScript 7 backend.
 *
 * Runs the same path as the extension in VS Code: a `tsc --lsp` server with the document
 * open, an API pipe from custom/initializeAPISession, and a new snapshot per hover
 * (TsgoHoverSession). Each hover is timed end to end, API requests are counted, and the
 * rendered output is recorded so a change that alters output is flagged.
 *
 * Usage: pnpm bench [label]   (results go to bench/results/<label>.json;
 *                              the first run saved as "baseline" is compared against)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { PrettifyOptions } from "../packages/typescript-plugin/src/request";
import { TsgoHoverSession } from "../packages/vscode-extension/src/tsgo/hover-session";
import { prettyPrintTypeString, stringifyTypeTree } from "../packages/vscode-extension/src/stringify-type-tree";
import { startLspServer } from "../test/tsgo/lsp-server";

const WARMUP_ROUNDS = 3;
const ROUNDS = 20;
const COLD_RUNS = 3;

const benchDir = path.resolve("bench");
const workspaceDir = path.join(benchDir, "workspace");
const casesFile = path.join(workspaceDir, "cases.ts");
const resultsDir = path.join(benchDir, "results");

/** The extension's default settings (packages/vscode-extension/package.json) */
const options: PrettifyOptions = {
  hidePrivateProperties: true,
  maxDepth: 2,
  maxProperties: 100,
  maxSubProperties: 5,
  maxUnionMembers: 15,
  maxFunctionSignatures: 5,
  skippedTypeNames: [
    "Array",
    "ArrayBuffer",
    "Buffer",
    "Date",
    "Element",
    "Error",
    "Map",
    "Number",
    "RegExp",
    "Set",
    "String",
    "Symbol",
  ],
  unwrapArrays: true,
  unwrapFunctions: true,
  unwrapGenericArgumentsTypeNames: ["Promise", "Set", "Map", "Observable"],
};

type CaseResult = {
  medianMs: number;
  p90Ms: number;
  minMs: number;
  /** Median for hovering the same symbol again without edits (cached results) */
  repeatMedianMs?: number;
  requests: number;
  bytesReceived: number;
  output: string;
};

type BenchResult = {
  label: string;
  date: string;
  rounds: number;
  coldMs: number[];
  cases: Record<string, CaseResult>;
};

function readCases(text: string): { name: string; offset: number }[] {
  return [...text.matchAll(/\/\*@bench ([\w-]+)\*\/\s*/g)].map((match) => ({
    name: match[1]!,
    offset: match.index + match[0].length,
  }));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

type Counters = {
  requests: number;
  bytesReceived: number;
  byMethod: Map<string, { count: number; bytes: number; ms: number }>;
};

/** Counts API requests and response bytes by wrapping the client's request methods */
function instrument(session: TsgoHoverSession): Counters {
  const counters: Counters = { requests: 0, bytesReceived: 0, byMethod: new Map() };
  const client = (session.api as unknown as { client: Record<string, (...args: unknown[]) => Promise<unknown>> })
    .client;

  for (const method of ["apiRequest", "apiRequestBinary"]) {
    const original = client[method]!.bind(client);
    client[method] = async (...args: unknown[]) => {
      counters.requests++;
      const started = performance.now();
      const result = await original(...args);
      const ms = performance.now() - started;
      let size = 0;
      if (result instanceof Uint8Array) size = result.byteLength;
      else if (result !== undefined) size = JSON.stringify(result).length;
      counters.bytesReceived += size;
      const entry = counters.byMethod.get(String(args[0])) ?? { count: 0, bytes: 0, ms: 0 };
      entry.count++;
      entry.bytes += size;
      entry.ms += ms;
      counters.byMethod.set(String(args[0]), entry);
      return result;
    };
  }
  return counters;
}

function render(info: Awaited<ReturnType<TsgoHoverSession["getTypeInfo"]>>): string {
  return info ? info.declaration + prettyPrintTypeString(stringifyTypeTree(info.typeTree, false), 4) : "<no type info>";
}

async function measureCold(text: string, offset: number): Promise<number> {
  const server = await startLspServer(workspaceDir);
  try {
    const uri = server.openDocument(casesFile, text);
    const session = new TsgoHoverSession(await server.connectApi());
    const started = performance.now();
    await session.getTypeInfo(uri, offset, options);
    const elapsed = performance.now() - started;
    await session.api.close();
    return elapsed;
  } finally {
    server.stop();
  }
}

async function main(): Promise<void> {
  const label = process.argv[2] ?? "latest";

  // `pnpm bench --breakdown <case>`: per-method request counts for one hover, no timing
  if (label === "--breakdown") return breakdown(process.argv[3] ?? "dom-element");
  const text = fs.readFileSync(casesFile, "utf8");
  const cases = readCases(text);

  // Cold: first hover on a fresh server (includes program creation), on the heaviest case
  const coldCase = cases.find((c) => c.name === "dom-element")!;
  const coldMs: number[] = [];
  for (let run = 0; run < COLD_RUNS; run++) coldMs.push(await measureCold(text, coldCase.offset));

  const server = await startLspServer(workspaceDir);
  const uri = server.openDocument(casesFile, text);
  const session = new TsgoHoverSession(await server.connectApi());
  const counters = instrument(session);

  const samples = new Map<string, number[]>(cases.map((c) => [c.name, []]));
  const repeatSamples = new Map<string, number[]>(cases.map((c) => [c.name, []]));
  const requestCounts = new Map<string, number>();
  const bytes = new Map<string, number>();
  const outputs = new Map<string, string>();

  try {
    for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
      // Interleave cases each round so drift (thermal, background load) spreads evenly
      for (const { name, offset } of cases) {
        // Primary metric: a hover right after an edit, with nothing cached
        session.markStale();
        const requestsBefore = counters.requests;
        const bytesBefore = counters.bytesReceived;

        const started = performance.now();
        const info = await session.getTypeInfo(uri, offset, options);
        const elapsed = performance.now() - started;
        const requests = counters.requests - requestsBefore;
        const received = counters.bytesReceived - bytesBefore;

        // Secondary metric: hovering the same symbol again without edits
        const repeatStarted = performance.now();
        const repeatInfo = await session.getTypeInfo(uri, offset, options);
        const repeatElapsed = performance.now() - repeatStarted;

        if (round < WARMUP_ROUNDS) continue;
        if (render(repeatInfo) !== render(info)) throw new Error(`Repeat hover output differs for ${name}`);
        samples.get(name)!.push(elapsed);
        repeatSamples.get(name)!.push(repeatElapsed);
        requestCounts.set(name, requests);
        bytes.set(name, received);
        outputs.set(name, render(info));
      }
    }
  } finally {
    await session.api.close();
    server.stop();
  }

  const result: BenchResult = { label, date: new Date().toISOString(), rounds: ROUNDS, coldMs, cases: {} };
  for (const { name } of cases) {
    const sorted = [...samples.get(name)!].sort((a, b) => a - b);
    result.cases[name] = {
      medianMs: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
      minMs: sorted[0]!,
      repeatMedianMs: percentile(
        [...repeatSamples.get(name)!].sort((a, b) => a - b),
        0.5,
      ),
      requests: requestCounts.get(name)!,
      bytesReceived: bytes.get(name)!,
      output: outputs.get(name)!,
    };
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${label}.json`), JSON.stringify(result, null, 2) + "\n");

  const baselinePath = path.join(resultsDir, "baseline.json");
  const baseline: BenchResult | undefined =
    label !== "baseline" && fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : undefined;

  printResults(result, baseline);
}

async function breakdown(caseName: string): Promise<void> {
  const text = fs.readFileSync(casesFile, "utf8");
  const target = readCases(text).find((c) => c.name === caseName);
  if (!target) throw new Error(`Unknown case ${caseName}`);

  const server = await startLspServer(workspaceDir);
  try {
    const uri = server.openDocument(casesFile, text);
    const session = new TsgoHoverSession(await server.connectApi());
    await session.getTypeInfo(uri, target.offset, options); // warm up
    session.markStale();
    const counters = instrument(session);
    const started = performance.now();
    await session.getTypeInfo(uri, target.offset, options);
    console.log(`\nwall time ${(performance.now() - started).toFixed(1)}ms`);

    console.log(`\n${caseName}: ${counters.requests} requests, ${(counters.bytesReceived / 1024).toFixed(1)} KB\n`);
    // Round trips overlap, so summed time is a relative measure, not wall time
    console.log(`${"method".padEnd(34)}${"count".padEnd(10)}${"KB".padEnd(14)}summed round trips`);
    for (const [method, { count, bytes, ms }] of [...counters.byMethod].sort((a, b) => b[1].ms - a[1].ms)) {
      console.log(
        `${method.padEnd(34)}${String(count).padEnd(10)}${(bytes / 1024).toFixed(1).padEnd(14)}${ms.toFixed(0)}ms`,
      );
    }
    await session.api.close();
  } finally {
    server.stop();
  }
}

function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined || previous === 0) return "";
  const change = ((current - previous) / previous) * 100;
  return ` (${change > 0 ? "+" : ""}${change.toFixed(0)}%)`;
}

function printResults(result: BenchResult, baseline: BenchResult | undefined): void {
  const fmt = (ms: number) => `${ms.toFixed(1)}ms`;
  console.log(`\n${result.label}: ${result.rounds} rounds per case${baseline ? `, compared to baseline` : ""}\n`);
  console.log(
    `${"case".padEnd(22)}${"median".padEnd(20)}${"p90".padEnd(12)}${"min".padEnd(12)}${"requests".padEnd(18)}${"KB recv".padEnd(12)}repeat`,
  );

  let totalMedian = 0;
  let baselineTotal = 0;
  const changedOutputs: string[] = [];

  for (const [name, c] of Object.entries(result.cases)) {
    const b = baseline?.cases[name];
    totalMedian += c.medianMs;
    baselineTotal += b?.medianMs ?? 0;
    // Whitespace is layout, not content, so formatting changes don't count as different output
    if (b && b.output.replace(/\s+/g, "") !== c.output.replace(/\s+/g, "")) changedOutputs.push(name);

    console.log(
      name.padEnd(22) +
        (fmt(c.medianMs) + formatDelta(c.medianMs, b?.medianMs)).padEnd(20) +
        fmt(c.p90Ms).padEnd(12) +
        fmt(c.minMs).padEnd(12) +
        (String(c.requests) + formatDelta(c.requests, b?.requests)).padEnd(18) +
        (c.bytesReceived / 1024).toFixed(1).padEnd(12) +
        (c.repeatMedianMs === undefined ? "-" : fmt(c.repeatMedianMs)),
    );
  }

  console.log(
    `\n${"sum of medians".padEnd(22)}${fmt(totalMedian)}${formatDelta(totalMedian, baseline ? baselineTotal : undefined)}`,
  );
  const coldMedian = [...result.coldMs].sort((a, b) => a - b)[Math.floor(result.coldMs.length / 2)]!;
  const baselineCold = baseline
    ? [...baseline.coldMs].sort((a, b) => a - b)[Math.floor(baseline.coldMs.length / 2)]
    : undefined;
  console.log(`${"cold first hover".padEnd(22)}${fmt(coldMedian)}${formatDelta(coldMedian, baselineCold)}`);

  if (changedOutputs.length > 0) {
    console.log(`\n⚠ Output differs from baseline for: ${changedOutputs.join(", ")}`);
    process.exitCode = 1;
  } else if (baseline) {
    console.log(`\n✓ Output identical to baseline for all cases`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
