/* eslint-disable @typescript-eslint/no-unused-vars */
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
