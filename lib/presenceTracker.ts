// Pure presence state machine (unit-tested): fed "face seen / not seen"
// twice a second by the webcam watcher, it says when the user has come back
// and how long they've been away.

// Looking down at the phone or turning away shouldn't count as leaving.
const GONE_AFTER_MS = 20_000;

export class PresenceTracker {
  private present = false;
  private lastSeen = 0;
  private leftAt: number | null = null;
  private lastAwayReport = 0;

  constructor(private readonly minAwayForGreeting = 3 * 60_000) {}

  update(faceSeen: boolean, now: number): { arrived?: number; away?: number } {
    if (faceSeen) {
      this.lastSeen = now;
      if (!this.present) {
        this.present = true;
        const away = this.leftAt === null ? null : now - this.leftAt;
        this.leftAt = null;
        if (away !== null && away >= this.minAwayForGreeting) return { arrived: away };
      }
      return {};
    }
    if (this.present && now - this.lastSeen >= GONE_AFTER_MS) {
      this.present = false;
      this.leftAt = this.lastSeen;
      this.lastAwayReport = now;
    }
    if (!this.present && this.leftAt !== null && now - this.lastAwayReport >= 60_000) {
      this.lastAwayReport = now;
      return { away: now - this.leftAt };
    }
    return {};
  }
}

