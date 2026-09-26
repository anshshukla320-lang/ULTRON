# ULTRON Orb UI

An Iron Man–inspired holographic orb built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — control it with your bare hands through your webcam.

> 🔮 This is the open-source **interface** of [ULTRON](https://sagartamang.com/projects/ultron) — my AI that talks in real time and controls Android devices by itself. **[Read the write-up](https://sagartamang.com/projects/ultron)** or **[the X post](https://x.com/sagar_builds/status/2077277583646101921)**

> 📱 **[Watch the demo on Instagram](https://www.instagram.com/p/DayJ17OTwvx/)**

![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move it | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |

## Voice assistant

Say **"Hey Ultron"** and talk. Replies stream: ULTRON starts speaking the
first sentence while the rest is still being written. Say **"stop"** (or
"never mind") to cut it off, or **"Hey Ultron, …"** to interrupt with a new
request. `V` mutes the mic and voice.

A few things to try:

| Say | What happens |
| --- | --- |
| "Set a 10 minute timer for the pasta" | Announced out loud when it's done |
| "Remind me at 6 to call mum" | Reminders survive restarts |
| "Brief me" / "Brief me every day at 7:30" | Weather, today's calendar, important email, tasks |
| "What's the weather tomorrow?" | Live forecast (set `ULTRON_HOME_LOCATION`) |
| "What's this error on my screen?" | Takes a screenshot and reads it |
| "Volume to 30" / "Next track" / "Lock the PC" | PC and media controls |
| "Free up some disk space" | Scans junk, deletes only what you approve |

**How it gets smarter than a script:**

- **Thinks harder when it matters.** Everyday requests are answered by a
  fast model; genuinely hard questions are passed to a more capable one
  (Claude Opus 5, via the API's advisor tool) before answering. Set
  `ULTRON_ADVISOR=off` to disable.
- **Remembers conversations.** When a conversation ends, it's summarized
  and lasting facts about you are saved automatically, so ULTRON can pick
  up threads later ("How did the interview go?"). Ask "what did we talk
  about last week?" to search older ones.
- **Speaks up on its own** — a meeting starting in 10 minutes, an
  important email, low disk space, rain on the way — never between 22:00
  and 07:00. "Stop the notifications" or "quiet hours 23:00 to 8:00"
  changes that.
- **Reads the room.** How fast you're talking, cutting it off, or repeating
  yourself changes how it answers: shorter when you're rushed, owning the
  mistake when you're frustrated, warmer when you're chatting.

Anything risky (sending email, running code, installing apps, shutting
down, deleting files) shows a confirm box first. Setup for keys and
accounts is in `.env.example`.

### Tests

```bash
npm test        # unit + agent-loop tests (no API key or Windows needed)
npm run typecheck
```

## How it works

- **`lib/orbScene.ts`** — the Three.js scene: layered wireframe shells, a spiral
  inner core, floating code-text sprites, orbiting debris, dust particles, scan
  rings, and a bloom + chromatic-aberration post-processing stack.
- **`lib/handTracker.ts`** — MediaPipe HandLandmarker running on the webcam
  feed. Pinch detection with hysteresis: one pinched hand spins the orb, two
  pinched hands zoom by spreading apart or together.
- **`components/JarvisOrb.tsx`** — the HUD and glue between the scene, the
  tracker, and your inputs.

## License

MIT
