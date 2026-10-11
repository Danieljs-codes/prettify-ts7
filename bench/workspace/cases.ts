/* eslint-disable @typescript-eslint/no-unused-vars */
// Benchmark workload. Each @bench marker comment is hovered on the identifier right after it.

// Small object: the floor for per-hover overhead
type /*@bench small-object*/ SmallObject = { id: number; name: string };

// DOM element: hundreds of properties, methods, and nested objects from lib.dom.d.ts
const /*@bench dom-element*/ divElement = document.createElement("div");

// Window: one of the largest types in lib.dom.d.ts
const /*@bench window*/ win = window;

// Big string union
type Region = `${"us" | "eu" | "ap" | "sa"}-${"north" | "south" | "east" | "west"}-${1 | 2 | 3}`;
type /*@bench big-union*/ RegionConfig = { region: Region; fallback?: Region };

// Deep nested object
type /*@bench deep-object*/ AppConfig = {
  server: {
    http: { port: number; host: string; tls: { cert: string; key: string; ciphers: string[] } };
    limits: { requests: number; burst: number; windowMs: number };
  };
  database: {
    primary: { url: string; pool: { min: number; max: number; idleMs: number } };
    replicas: { url: string; weight: number }[];
  };
  features: Record<"search" | "billing" | "audit" | "export", { enabled: boolean; rollout: number }>;
  hooks: { onStart(): void; onStop(reason: string): Promise<void> };
};

// Overloaded function from lib.dom.d.ts
const /*@bench overloads*/ listen = document.addEventListener;

// Class instance with many members
class Repository<T extends { id: string }> {
  private cache = new Map<string, T>();
  protected dirty = false;
  constructor(readonly name: string) {}
  get(id: string): T | undefined {
    return this.cache.get(id);
  }
  set(item: T): void {
    this.cache.set(item.id, item);
  }
  delete(id: string): boolean {
    return this.cache.delete(id);
  }
  list(filter?: (item: T) => boolean): T[] {
    return [...this.cache.values()].filter(filter ?? (() => true));
  }
  async flush(): Promise<{ written: number; failed: string[] }> {
    return { written: 0, failed: [] };
  }
}
const /*@bench class-instance*/ users = new Repository<{ id: string; email: string; roles: ("admin" | "user")[] }>(
    "users",
  );

// Promise-returning API from lib.dom.d.ts
const /*@bench fetch-response*/ response = fetch("/api");

// Intersection of mapped types
type Base = { id: string; createdAt: Date; updatedAt: Date };
type /*@bench mapped-intersection*/ Editable = Partial<Omit<AppConfig["database"], "replicas">> & Readonly<Base>;
