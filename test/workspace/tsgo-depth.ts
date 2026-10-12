/* eslint-disable @typescript-eslint/no-unused-vars */
type Classify<T extends string> = { readonly instructions: string; readonly criteria: Record<T, string> };
type Rate<T extends string> = {
  readonly instructions: string;
  readonly criteria?: { readonly min: T; readonly max: T };
};
type Probability = { readonly instructions: string; readonly criteria: ReadonlyArray<string> };
type DepthAny = Classify<string> | Rate<string> | Probability;
type DepthRecord = Record<"a" | "b", number>;
const depthRecordUse: Record<string, number> = {};
