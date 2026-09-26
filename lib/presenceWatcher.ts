import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { PresenceTracker } from "./presenceTracker";

// Webcam presence: is someone sitting at the PC? A face detector runs on
// the camera twice a second, entirely in the browser — frames never leave
// the page. Reports arrivals (after being away a while) and how long the
// user has been gone.

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const FRAME_MS = 500;

export interface PresenceEvents {
  /** The user sat down again after being away at least `awayMs`. */
  onArrive(awayMs: number): void;
  /** Called about once a minute while nobody is there. */
  onAway(awayMs: number): void;
}

export class PresenceWatcher {
  private detector: FaceDetector | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tracker = new PresenceTracker();

  constructor(private readonly events: PresenceEvents) {}

  async start(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    this.detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
    });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 5 } });
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  private tick(): void {
    if (!this.detector || !this.video || this.video.readyState < 2) return;
    const now = performance.now();
    let seen = false;
    try {
      seen = this.detector.detectForVideo(this.video, now).detections.length > 0;
    } catch {
      return;
    }
    const r = this.tracker.update(seen, Date.now());
    if (r.arrived !== undefined) this.events.onArrive(r.arrived);
    if (r.away !== undefined) this.events.onAway(r.away);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.detector?.close();
    this.detector = null;
    this.stream = null;
    this.video = null;
  }
}
