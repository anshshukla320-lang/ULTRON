// Pure trigger logic for security mode (unit-tested): fire when a face is in
// most of the last few frames — one stray detection (a poster, a shadow)
// shouldn't send a photo — then stay quiet for a while.

export class IntruderTrigger {
  private recent: boolean[] = [];
  private lastFired = -Infinity;

  constructor(
    private readonly window = 4,
    private readonly needed = 3,
    private readonly cooldownMs = 2 * 60_000,
  ) {}

  update(faceSeen: boolean, now: number): boolean {
    this.recent.push(faceSeen);
    if (this.recent.length > this.window) this.recent.shift();
    if (now - this.lastFired < this.cooldownMs) return false;
    if (this.recent.filter(Boolean).length < this.needed) return false;
    this.lastFired = now;
    this.recent = [];
    return true;
  }
}
