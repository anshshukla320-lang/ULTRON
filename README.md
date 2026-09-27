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

**More it can do:**

- **Runs in the background.** `scripts\ultron-background.ps1` starts ULTRON
  hidden with a tray icon; `scripts\install-startup.ps1` makes it start
  with Windows. Reminders, notices and the briefing then arrive as Windows
  notifications and are spoken even with no browser tab open.
- **Uses the computer for you.** "Fill in this form", "rename these files" —
  it looks at the screen and clicks and types (Claude computer use). Every
  task asks first; say "stop" or push the mouse into the top-left corner to
  halt it. It won't enter passwords or payment details, buy, send or delete.
- **Settings page** (`/settings`): what it remembers about you, past
  conversations, reminders, feature switches, quiet hours, and what it
  spends on the Claude API each day (with an optional daily cap).
- **Your documents.** "What does my lease say about notice?" searches PDFs,
  Word and text files in the workspace and any folders listed in
  `ULTRON_DOCUMENT_FOLDERS`.
- **Messaging.** "Tell Priya I'm running late on WhatsApp" (WhatsApp desktop,
  confirmed first). Text ULTRON from your phone through a Telegram bot.
- **Smart home.** "Turn off the bedroom light", "dim it to 30", "make it
  blue", "switch the fan on", "turn on the TV and open YouTube", "TV volume
  down". Smart Life / Tuya lights and plugs, Android / Google TVs, and Home
  Assistant; locks, alarms and garage doors need confirmation. Setup below.
- **Better hearing.** `scripts\install-whisper.ps1`, then Settings >
  Hearing > Whisper: local, offline, more accurate, understands Hindi.

- **Routines.** "When I say good night, turn off the lights and the TV and
  put the PC to sleep" — then just say "good night". Routines can run on a
  schedule too ("every night at 11:30", "lights on at sunset"). A routine
  that includes anything needing confirmation shows every step first.
- **IR blaster.** A Smart Life IR blaster (about ₹1,000) copies your AC, fan
  and TV remotes: "set the AC to 24", "fan speed up". Add the remotes to the
  blaster in the Smart Life app; ULTRON finds them.
- **Push-to-talk.** Press Ctrl+Shift+Space anywhere (change it in Settings)
  and ULTRON listens — no wake word, even when minimised. It opens the page
  if it isn't open.
- **Offline wake word.** With local Whisper, "Hey ULTRON" is heard on your
  PC by a small fast model — no Google, no internet.
- **Voice lock.** Settings > "Only obey my voice": record three sentences
  and ULTRON ignores other people, the TV and videos (needs local Whisper).
- **Focus mode.** "Help me focus for an hour" — Pomodoro rounds, breaks
  announced, and a nudge if YouTube or social media sneaks in. "How long was
  I on YouTube today?" (screen time is kept on your PC, app names only).
- **Live info.** Headlines, stock prices ("how's Reliance doing?", Nifty,
  Sensex) and cricket scores — plus headlines and your watchlist in the
  morning briefing.
- **Bill reminders.** ULTRON checks Gmail daily for electricity, phone,
  broadband and credit-card bills and reminds you two days before each is due.
- **Clipboard.** Copy anything and say "summarise this", "translate this" or
  "write a reply to this" — replies go back on the clipboard to paste.
- **Webcam presence.** Settings > Webcam presence: ULTRON greets you when you
  sit down and can lock the PC when you walk away. Face detection runs in
  the browser; video never leaves the PC.
- **Custom voice.** Settings > Voice: pick a voice and speed.
  `scripts\install-piper-voice.ps1 butler` (or jarvis, us-male, us-female,
  uk-female, narrator) adds more.
- **Phone app.** A real Android app with ULTRON's mind — see below.

Anything risky (sending email, running code, installing apps, shutting
down, deleting files) shows a confirm box first. Setup for keys and
accounts is in `.env.example`.

### Smart home setup

**Smart Life lights and plugs** (Wipro, Syska, Halonix, Havells and other
brands controlled from the Smart Life / Tuya app). About 10 minutes, once:

1. Sign up at [iot.tuya.com](https://iot.tuya.com) (free).
2. **Cloud > Development > Create Cloud Project.** Development method
   *Smart Home*; data center *India* (the one your Smart Life account is in;
   otherwise set `TUYA_REGION`, see `.env.example`). Keep the suggested API services
   (IoT Core must be among them).
3. Open the project, **Devices > Link App Account > Add App Account**, and scan
   the QR code with the Smart Life app (Me > scan icon, top right). All your
   app devices now appear in the project.
4. From the project's **Overview**, copy the Access ID and Access Secret into
   `.env.local` as `TUYA_ACCESS_ID` and `TUYA_ACCESS_SECRET`, then restart ULTRON.

Tuya's free IoT Core plan has to be renewed every few months (free, one
form on iot.tuya.com); ULTRON tells you when it has expired.

A **fan without Wi-Fi** can be controlled by plugging it into a Wi-Fi smart
plug that works with Smart Life. Name the plug "Fan" in the app.

**Android / Google TV** (Sony, Mi, TCL, OnePlus, Hisense, Vu...):

1. On the TV: **Settings > Device Preferences > About**, press *Build* 7 times
   to unlock Developer options. Then **Developer options > USB debugging** on
   (and *Network debugging* / *ADB over network* if your TV has it).
2. Find the TV's IP address under **Settings > Network**. Reserving that
   address in your router's DHCP settings keeps it from changing.
3. On the PC: `powershell -ExecutionPolicy Bypass -File scripts\install-adb.ps1 -Tv <TV-IP>`,
   then accept **Allow debugging?** on the TV (tick *Always allow*).
4. Put `ANDROID_TV_HOST=<TV-IP>` in `.env.local` and restart ULTRON.

To switch the TV on from standby, turn on *network standby* / *remote start*
in the TV's settings if it has it.

### Phone app (Android)

A real Android app with ULTRON's mind. When your PC is reachable it *is*
the full ULTRON — the same memory, routines, smart home, Gmail and PC
control — plus the phone's own abilities, which ULTRON on the PC can use:
calls, texts, WhatsApp, contacts, alarms, timers, opening apps, directions,
torch, location, battery, volume and music. When the PC is off or out of
reach, the phone thinks on its own (Claude directly, with the same phone
abilities, web search and a copy of what ULTRON knows about you); anything
it learns is handed back to the PC next time. The badge at the top shows
which brain answered.

**Install:** open the latest *ULTRON for Android* release on this repository's
GitHub page (Releases) on your phone, tap the `.apk`, and allow installing
from your browser when Android asks.

**Set up (⚙ in the app):**

- **PC address and password** — the same password as the web page. To reach
  the PC away from home, use [Tailscale](https://tailscale.com) (free):
  install it on the PC and the phone with the same account, run
  `tailscale serve --bg 3000` on the PC, and enter the `https://….ts.net`
  address it prints. At home, `http://<PC's IP>:3000` also works.
- **Anthropic API key** (optional) — lets the phone answer when the PC is
  away. Stored encrypted on the phone.
- *Test connection* checks the PC.

**Talk to it:** tap the orb; tap again to interrupt. It keeps listening for a
follow-up after each reply (switch off in settings). Start talking in one tap
from the Quick Settings tile (pull down the shade → ✎ → add ULTRON) or by
long-pressing the app icon → *Talk to ULTRON*. For calls, texts and WhatsApp,
ULTRON opens the dialler or messaging app with everything filled in and you
tap call or send. (It never sends or calls by itself: Google Play Protect
blocks sideloaded apps that can.)

**Signing (once, so updates install over the old app):** the build is signed
with a key kept in this repository's secrets. Without it each build gets a new
key and Android makes you uninstall before updating (losing the app's
settings). Add three secrets under GitHub → Settings → Secrets and variables →
Actions: `ANDROID_KEYSTORE_B64` (the keystore file, base64), `ANDROID_KEYSTORE_PASSWORD`
and `ANDROID_KEY_ALIAS`. The app is built by `.github/workflows/android.yml`;
`android/` holds the source (`core/` is the brain and PC link, testable with
`./gradlew :core:test`; `app/` is the Android app).

On an iPhone, open ULTRON in Safari over Tailscale and use Share → **Add to
Home Screen** instead.

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
