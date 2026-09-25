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
