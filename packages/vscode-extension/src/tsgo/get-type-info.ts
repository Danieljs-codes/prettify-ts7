import type * as vscode from "vscode";
import type { PrettifyOptions } from "@prettify-ts7/typescript-plugin/src/request";

import { getTsgoApi, resetTsgoApi, tsgoOutputChannel } from "./connection";
import { getTypeInfoAtPosition, type TsgoTypeInfo } from "./type-tree";

/** Documents opened in the API session because the server had no project for them yet */
const openedDocuments = new Set<string>();

/**
 * Get prettified type info at a position from the TypeScript 7 language server
 */
export async function getTsgoTypeInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: PrettifyOptions,
): Promise<TsgoTypeInfo | undefined> {
  const api = await getTsgoApi();
  if (!api) return undefined;

  const uri = document.uri.toString();
  const documentId = { uri };

  try {
    let snapshot = await api.updateSnapshot();
    let project = await snapshot.getDefaultProjectForFile(documentId);

    // Files outside any project the server has loaded need an explicit open
    if (!project && !openedDocuments.has(uri)) {
      openedDocuments.add(uri);
      await snapshot.dispose();
      snapshot = await api.updateSnapshot({ openFiles: [documentId] });
      project = await snapshot.getDefaultProjectForFile(documentId);
    }

    try {
      if (!project) return undefined;

      const sourceFile = await project.program.getSourceFile(documentId);
      if (!sourceFile) return undefined;

      return await getTypeInfoAtPosition(project, sourceFile, document.offsetAt(position), options);
    } finally {
      await snapshot.dispose();
    }
  } catch (error) {
    tsgoOutputChannel.appendLine(
      `TypeScript 7 request failed: ${error instanceof Error ? error.stack : String(error)}`,
    );
    resetTsgoApi();
    openedDocuments.clear();
    return undefined;
  }
}
