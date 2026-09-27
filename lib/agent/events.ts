import { EventEmitter } from "node:events";

// Server → page events (the push-to-talk hotkey, for now), delivered over
// /api/events. Kept on globalThis because route handlers and background
// services can be bundled as separate module instances in one process.

export type PageEvent =
  | { type: "listen" }
  /** Start/stop recording a meeting on the PC page's microphone. */
  | { type: "meeting"; action: "start" | "stop"; id: string };

const g = globalThis as { __ultronEvents?: EventEmitter };
const bus = (g.__ultronEvents ??= new EventEmitter().setMaxListeners(50));

export function emitPageEvent(e: PageEvent): number {
  bus.emit("event", e);
  return bus.listenerCount("event");
}

export function onPageEvent(fn: (e: PageEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
