import * as vscode from "vscode";
import type { PrettifyOptions, PrettifyRequest } from "@prettify-ts7/typescript-plugin/src/request";
import type { TypeInfo } from "@prettify-ts7/typescript-plugin/src/type-tree/types";

import { isTsgoEnabled } from "./tsgo/connection";
import { getTsgoTypeInfo } from "./tsgo/get-type-info";

export type PrettifyTypeInfo = TypeInfo & {
  /** TypeScript's own quick info text for the hovered symbol, used to skip duplicate hovers */
  getQuickInfoText: () => Promise<string | undefined>;
};

export function getPrettifyOptions(config: vscode.WorkspaceConfiguration): PrettifyOptions {
  return {
    hidePrivateProperties: config.get("hidePrivateProperties", true),
    maxDepth: config.get("maxDepth", 2),
    maxProperties: config.get("maxProperties", 100),
    maxSubProperties: config.get("maxSubProperties", 5),
    maxUnionMembers: config.get("maxUnionMembers", 15),
    maxFunctionSignatures: config.get("maxFunctionSignatures", 5),
    skippedTypeNames: config.get("skippedTypeNames", [] as string[]),
    unwrapArrays: config.get("unwrapArrays", true),
    unwrapFunctions: config.get("unwrapFunctions", true),
    unwrapGenericArgumentsTypeNames: config.get("unwrapGenericArgumentsTypeNames", [] as string[]),
  };
}

/**
 * Get prettified type info at a position, from TypeScript 7 when it's enabled,
 * otherwise from the TS Server plugin (TypeScript 6 and earlier)
 */
export async function getTypeInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: PrettifyOptions,
): Promise<PrettifyTypeInfo | undefined> {
  if (isTsgoEnabled()) {
    const info = await getTsgoTypeInfo(document, position, options);
    if (!info) return undefined;

    return { ...info, getQuickInfoText: () => Promise.resolve(info.quickInfoTypeString) };
  }

  return getTsServerTypeInfo(document, position, options);
}

async function getTsServerTypeInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: PrettifyOptions,
): Promise<PrettifyTypeInfo | undefined> {
  const request: PrettifyRequest = {
    meta: "prettify-ts7-type-info-request",
    options,
  };

  const location = {
    file: document.uri.fsPath,
    line: position.line + 1,
    offset: position.character + 1,
  };

  const response: any = await vscode.commands.executeCommand("typescript.tsserverRequest", "completionInfo", {
    ...location,
    triggerCharacter: request,
  });

  const prettifyResponse: TypeInfo | undefined = response?.body?.__prettifyResponse;
  if (!prettifyResponse) return undefined;

  return {
    ...prettifyResponse,
    getQuickInfoText: async () => {
      const quickInfo: { body?: { displayString?: string } } | undefined = await vscode.commands.executeCommand(
        "typescript.tsserverRequest",
        "quickinfo",
        location,
      );
      return quickInfo?.body?.displayString;
    },
  };
}
