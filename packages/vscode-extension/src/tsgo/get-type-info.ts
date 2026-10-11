import type * as vscode from "vscode";
import type { PrettifyOptions } from "@prettify-ts7/typescript-plugin/src/request";

import { getTsgoSession, resetTsgoApi, tsgoOutputChannel } from "./connection";
import type { TsgoTypeInfo } from "./type-tree";

/**
 * Get prettified type info at a position from the TypeScript 7 language server
 */
export async function getTsgoTypeInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: PrettifyOptions,
): Promise<TsgoTypeInfo | undefined> {
  const session = await getTsgoSession();
  if (!session) return undefined;

  try {
    return await session.getTypeInfo(document.uri.toString(), document.offsetAt(position), options);
  } catch (error) {
    tsgoOutputChannel.appendLine(
      `TypeScript 7 request failed: ${error instanceof Error ? error.stack : String(error)}`,
    );
    resetTsgoApi();
    return undefined;
  }
}
