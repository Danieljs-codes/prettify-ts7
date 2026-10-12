/**
 * Runs the hover expectations from test/suite/types.test.ts against the TypeScript 7
 * backend, by spawning tsgo directly instead of going through VS Code.
 *
 * Usage: pnpm test:tsgo
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { API } from "tsgo-api/unstable/async";

import type { PrettifyOptions } from "../../packages/typescript-plugin/src/request";
import { getTypeInfoAtPosition } from "../../packages/vscode-extension/src/tsgo/type-tree";
import {
  prettyPrintTypeString,
  stringifyTypeTree,
  toGenericReadonly,
  type ReadonlyStyle,
} from "../../packages/vscode-extension/src/stringify-type-tree";

// Run from the repo root
const testDir = path.resolve("test");
const workspaceDir = path.join(testDir, "workspace");

const options: PrettifyOptions = {
  hidePrivateProperties: true,
  maxDepth: 3,
  maxProperties: 100,
  maxSubProperties: 5,
  maxUnionMembers: 15,
  maxFunctionSignatures: 5,
  skippedTypeNames: [],
  unwrapArrays: true,
  unwrapFunctions: true,
  unwrapGenericArgumentsTypeNames: ["Promise", "TsgoEffect"],
};

function normalize(input: string): string {
  let type = input.replace(/\s+/g, " ").trim();
  if (type.endsWith(";")) type = type.slice(0, -1).trim();
  return type;
}

type TestCase = {
  file: string;
  keyword: string;
  expected: string;
  knownDifference?: string;
  readonlyStyle?: ReadonlyStyle;
};

/**
 * Cases where TypeScript 7's checker prints a type differently than TypeScript 5/6.
 * These are reported but don't fail the run.
 */
const knownDifferences: Record<string, string> = {
  TestOptionalRestTupleObj: "TS 7 prints optional tuple elements as `b?: number | undefined`",
};

/** Extra cases for behavior the VS Code suite doesn't cover, in workspace/tsgo-extra.ts */
const extraCases: TestCase[] = [
  { keyword: "TsgoUser(1)", expected: "function TsgoUser(id: number, name?: string): TsgoUser" },
  {
    keyword: "tsgoInstance",
    expected: "const tsgoInstance: { readonly id: number; name?: string; greet: () => string; }",
  },
  { keyword: "tsgoLet", expected: "let tsgoLet: { a: number; b: string; }" },
  { keyword: "tsgoVar", expected: "var tsgoVar: number[]" },
  { keyword: "TsgoPartial", expected: "type TsgoPartial = { a?: number; b?: string; }" },
  { keyword: "TsgoReadonly", expected: "type TsgoReadonly = { readonly a: number; readonly b: string; }" },
  { keyword: "TsgoInterface", expected: "interface TsgoInterface { x: number; nested: { y: string; z: boolean; }; }" },
  {
    keyword: "tsgoFunction",
    expected: `function tsgoFunction(
      input: { a: number; b: string; },
      ...rest: string[]
    ): { x: number; nested: { y: string; z: boolean; }; }`,
  },
  {
    keyword: "tsgoForEach(",
    expected: `function tsgoForEach(
      self: readonly (readonly [id: number, name: string])[],
      f: (a: readonly [id: number, name: string], i: number) => Promise<void>,
      options?: { readonly concurrency?: number | "unbounded"; readonly discard?: true; }
    ): Promise<void>`,
  },
  {
    // At a call site: the overload and generics TypeScript resolved, not the generic declaration
    keyword: "tsgoEffectForEach(tsgoRows",
    expected: `function tsgoEffectForEach(
      self: Iterable<readonly [id: number, name: string]>,
      f: (a: readonly [id: number, name: string], i: number) => TsgoEffect<number, never, never>,
      options: { readonly concurrency?: number | "unbounded"; readonly discard: true; }
    ): TsgoEffect<void, never, never>`,
  },
  { keyword: "TsgoImported", expected: "type TsgoImported = { value: { p: number; q: number; }; }" },
].map((testCase) => ({ ...testCase, file: "tsgo-extra.ts" }));

/** The `prettify-ts7.readonlyStyle: "generic"` setting */
const genericReadonlyCases: TestCase[] = [
  {
    file: "types.ts",
    keyword: "TestReadonlyArrayObj",
    expected: "type TestReadonlyArrayObj = { value: ReadonlyArray<string>; }",
  },
  {
    file: "types.ts",
    keyword: "TestReadonlyTupleObj",
    expected: "type TestReadonlyTupleObj = { value: Readonly<[boolean, boolean]>; }",
  },
  {
    file: "tsgo-extra.ts",
    keyword: "tsgoForEach(",
    expected: `function tsgoForEach(
      self: ReadonlyArray<Readonly<[id: number, name: string]>>,
      f: (a: Readonly<[id: number, name: string]>, i: number) => Promise<void>,
      options?: { readonly concurrency?: number | "unbounded"; readonly discard?: true; }
    ): Promise<void>`,
  },
  {
    file: "tsgo-extra.ts",
    keyword: "tsgoEffectForEach(tsgoRows",
    expected: `function tsgoEffectForEach(
      self: Iterable<Readonly<[id: number, name: string]>>,
      f: (a: Readonly<[id: number, name: string]>, i: number) => TsgoEffect<number, never, never>,
      options: { readonly concurrency?: number | "unbounded"; readonly discard: true; }
    ): TsgoEffect<void, never, never>`,
  },
].map((testCase) => ({ ...testCase, readonlyStyle: "generic" as const }));

/** toGenericReadonly on checker text: input, expected */
const genericReadonlyTextCases: [string, string][] = [
  ["Iterable<readonly [id: number, name: string]>", "Iterable<Readonly<[id: number, name: string]>>"],
  ["readonly (string | number)[]", "ReadonlyArray<string | number>"],
  ["Map<string, readonly string[]>", "Map<string, ReadonlyArray<string>>"],
  ["{ readonly [key: string]: string; readonly a: number }", "{ readonly [key: string]: string; readonly a: number }"],
  ["{ readonly [key: string]?: number }", "{ readonly [key: string]?: number }"],
];

/** Pull `getHover("X")` / `expected = ...` pairs out of the VS Code test suite */
function readCases(): TestCase[] {
  const source = fs.readFileSync(path.join(testDir, "suite/types.test.ts"), "utf8");
  const pattern = /getHover\("([^"]+)"\);\s*const expected = (?:\/\* ts \*\/ )?(`(?:[^`\\]|\\.)*`);/g;
  const suiteCases = [...source.matchAll(pattern)].map(([, keyword, literal]) => ({
    file: "types.ts",
    keyword: keyword!,
    // Unwrap the template literal: drop the backticks and unescape \` and \${
    expected: literal!.slice(1, -1).replace(/\\(.)/g, "$1"),
    knownDifference: knownDifferences[keyword!],
  }));
  return [...suiteCases, ...extraCases, ...genericReadonlyCases];
}

async function main(): Promise<void> {
  const api = new API({ cwd: workspaceDir });
  const snapshot = await api.updateSnapshot({ openProjects: [path.join(workspaceDir, "tsconfig.json")] });

  let failures = 0;
  let known = 0;
  const cases = readCases();
  const started = Date.now();

  for (const [input, expected] of genericReadonlyTextCases) {
    const actual = toGenericReadonly(input);
    if (actual === expected) {
      console.log(`  ✓ toGenericReadonly ${input}`);
    } else {
      failures++;
      console.log(`  ✗ toGenericReadonly ${input}\n      expected: ${expected}\n      actual:   ${actual}`);
    }
  }

  for (const { file, keyword, expected, knownDifference, readonlyStyle } of cases) {
    const fileName = path.join(workspaceDir, file);
    const text = fs.readFileSync(fileName, "utf8");
    const project = await snapshot.getDefaultProjectForFile(fileName);
    const sourceFile = await project?.program.getSourceFile(fileName);
    if (!project || !sourceFile) throw new Error(`No project for ${file}`);

    const position = text.indexOf(keyword) + 1;
    const caseStarted = Date.now();
    const info = await getTypeInfoAtPosition(project, sourceFile, position, options);
    const elapsed = Date.now() - caseStarted;

    const actual = info
      ? normalize(info.declaration + prettyPrintTypeString(stringifyTypeTree(info.typeTree, false, readonlyStyle), 4))
      : "<no type info>";

    if (actual === normalize(expected)) {
      console.log(`  ✓ ${keyword} (${elapsed}ms)`);
      continue;
    }

    const details = `\n      expected: ${normalize(expected)}\n      actual:   ${actual}`;
    if (knownDifference) {
      known++;
      console.log(`  ~ ${keyword} (known TS 7 difference: ${knownDifference})${details}`);
    } else {
      failures++;
      console.log(`  ✗ ${keyword} (${elapsed}ms)${details}`);
    }
  }

  const total = cases.length + genericReadonlyTextCases.length;
  const passed = total - failures - known;
  console.log(
    `\n${passed}/${total} passed, ${known} known differences, ${failures} failed in ${Date.now() - started}ms`,
  );
  await snapshot.dispose();
  await api.close();
  process.exitCode = failures > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
