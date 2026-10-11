import type { API, Project, Snapshot } from "tsgo-api/unstable/async";
import type { PrettifyOptions } from "@prettify-ts7/typescript-plugin/src/request";

import { createProjectQueryCache, getTypeInfoAtPosition, type ProjectQueryCache, type TsgoTypeInfo } from "./type-tree";

/**
 * A snapshot plus the query results computed from it. Reused by every hover until
 * something changes, then disposed once its in-flight hovers finish.
 */
type SnapshotEntry = {
  snapshot: Promise<Snapshot>;
  caches: Map<string, ProjectQueryCache>;
  /** Finished results by document, position, and options */
  results: Map<string, Promise<TsgoTypeInfo | undefined>>;
  inFlight: number;
  stale: boolean;
};

/**
 * Per-connection state for prettify requests against the TypeScript 7 API.
 * Kept free of `vscode` imports so benchmarks and tests run the same code as the extension.
 */
export class TsgoHoverSession {
  /** Documents opened in the API session because the server had no project for them yet */
  private readonly openedDocuments = new Set<string>();
  private current: SnapshotEntry | undefined;

  constructor(readonly api: API<true>) {}

  /**
   * Call when anything that could affect types changes (edits, saves, files on disk),
   * so the next hover takes a fresh snapshot instead of reusing cached results
   */
  markStale(): void {
    const entry = this.current;
    if (!entry) return;
    this.current = undefined;
    entry.stale = true;
    this.disposeIfUnused(entry);
  }

  async getTypeInfo(uri: string, offset: number, options: PrettifyOptions): Promise<TsgoTypeInfo | undefined> {
    const entry = this.acquire();
    const key = `${uri}\0${offset}\0${JSON.stringify(options)}`;

    let result = entry.results.get(key);
    if (!result) {
      result = this.computeTypeInfo(entry, uri, offset, options);
      entry.results.set(key, result);
      // Failures shouldn't be cached
      result.catch(() => entry.results.delete(key));
    }

    try {
      return await result;
    } finally {
      this.release(entry);
    }
  }

  private async computeTypeInfo(
    initialEntry: SnapshotEntry,
    uri: string,
    offset: number,
    options: PrettifyOptions,
  ): Promise<TsgoTypeInfo | undefined> {
    const documentId = { uri };

    let entry = initialEntry;
    entry.inFlight++;
    try {
      let snapshot = await entry.snapshot;
      let project = await snapshot.getDefaultProjectForFile(documentId);

      // Files outside any project the server has loaded need an explicit open
      if (!project && !this.openedDocuments.has(uri)) {
        this.openedDocuments.add(uri);
        this.markStale();
        this.release(entry);
        entry = this.acquire({ openFiles: [documentId] });
        snapshot = await entry.snapshot;
        project = await snapshot.getDefaultProjectForFile(documentId);
      }

      if (!project) return undefined;

      const sourceFile = await project.program.getSourceFile(documentId);
      if (!sourceFile) return undefined;

      return await getTypeInfoAtPosition(project, sourceFile, offset, options, getProjectCache(entry, project));
    } catch (error) {
      // Don't reuse a snapshot that failed mid-request
      if (this.current === entry) this.markStale();
      throw error;
    } finally {
      this.release(entry);
    }
  }

  private acquire(params?: Parameters<API<true>["updateSnapshot"]>[0]): SnapshotEntry {
    if (!this.current) {
      this.current = {
        snapshot: this.api.updateSnapshot(params),
        caches: new Map(),
        results: new Map(),
        inFlight: 0,
        stale: false,
      };
    }
    this.current.inFlight++;
    return this.current;
  }

  private release(entry: SnapshotEntry): void {
    entry.inFlight--;
    this.disposeIfUnused(entry);
  }

  private disposeIfUnused(entry: SnapshotEntry): void {
    if (!entry.stale || entry.inFlight > 0) return;
    void entry.snapshot.then((snapshot) => snapshot.dispose()).catch(() => undefined);
  }
}

function getProjectCache(entry: SnapshotEntry, project: Project): ProjectQueryCache {
  let cache = entry.caches.get(project.id);
  if (!cache) {
    cache = createProjectQueryCache(project);
    entry.caches.set(project.id, cache);
  }
  return cache;
}
