/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const, no-var */
// Extra fixtures for the TypeScript 7 backend (see test/tsgo/run-type-tests.ts)
import { type Mapped as ImportedMapped } from "./tsgo-extra-dep";

class TsgoUser {
  private secret = 1;
  protected guarded = 2;
  _internal = 3;
  readonly id: number;
  name?: string;
  constructor(id: number, name?: string) {
    this.id = id;
    this.name = name;
  }
  greet(): string {
    return "hi";
  }
}

const tsgoInstance = new TsgoUser(1);
let tsgoLet = { a: 1, b: "x" };
var tsgoVar = [1, 2, 3];

type TsgoBase = { a: number; b: string };
type TsgoPartial = Partial<TsgoBase>;
type TsgoReadonly = Readonly<TsgoBase>;

interface TsgoInterface {
  x: number;
  nested: { y: string; z: boolean };
}

function tsgoFunction(input: TsgoBase, ...rest: string[]): TsgoInterface {
  return { x: input.a, nested: { y: rest[0] ?? "", z: true } };
}

type TsgoImported = { value: ImportedMapped };

declare function tsgoForEach(
  self: readonly (readonly [id: number, name: string])[],
  f: (a: readonly [id: number, name: string], i: number) => Promise<void>,
  options?: { readonly concurrency?: number | "unbounded" | undefined; readonly discard?: true | undefined },
): Promise<void>;

// Shaped like Effect.forEach: generic, overloaded, returning an interface with many members
interface TsgoEffect<A, E, R> {
  readonly _A: A;
  readonly _E: E;
  readonly _R: R;
  toJSON(): unknown;
  pipe(): this;
  pipe<B>(ab: (_: this) => B): B;
}
declare function tsgoEffectSucceed<A>(a: A): TsgoEffect<A, never, never>;
declare function tsgoEffectForEach<A, B, E, R>(
  self: Iterable<A>,
  f: (a: A, i: number) => TsgoEffect<B, E, R>,
  options?: { readonly concurrency?: number | "unbounded"; readonly discard?: false },
): TsgoEffect<B[], E, R>;
declare function tsgoEffectForEach<A, B, E, R>(
  self: Iterable<A>,
  f: (a: A, i: number) => TsgoEffect<B, E, R>,
  options: { readonly concurrency?: number | "unbounded"; readonly discard: true },
): TsgoEffect<void, E, R>;
const tsgoRows: ReadonlyArray<readonly [id: number, name: string]> = [];
tsgoEffectForEach(tsgoRows, (row) => tsgoEffectSucceed(row[0]), { discard: true });
