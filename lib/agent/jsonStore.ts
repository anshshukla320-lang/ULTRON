import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// A small JSON file in ~/.ultron with serialized read-modify-write, for the
// feature stores (packages, habits, price watches…). The path is resolved on
// each call so tests can point HOME somewhere else.

export interface JsonStore<T> {
  read(): Promise<T>;
  /** Runs `fn` on the current value and saves it; calls are queued. */
  update<R>(fn: (value: T) => R | Promise<R>): Promise<R>;
}

export function jsonStore<T>(file: string, fallback: () => T): JsonStore<T> {
  const full = () => path.join(os.homedir(), ".ultron", file);
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<T> => {
    try {
      return { ...fallback(), ...(JSON.parse(await fs.readFile(full(), "utf-8")) as T) };
    } catch {
      return fallback();
    }
  };
  return {
    read,
    update<R>(fn: (value: T) => R | Promise<R>): Promise<R> {
      const next = queue.then(async () => {
        const value = await read();
        const result = await fn(value);
        await fs.mkdir(path.dirname(full()), { recursive: true });
        await fs.writeFile(full(), JSON.stringify(value, null, 2), "utf-8");
        return result;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Once a day at/after HH:MM": true the first time it's asked on a day past that time. */
export function dailyDue(time: string, last: string | undefined, now = new Date()): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return false;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
  return now.getTime() >= at.getTime() && last !== localDay(now);
}
