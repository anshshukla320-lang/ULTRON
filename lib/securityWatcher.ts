import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { IntruderTrigger } from "./intruderTrigger";

// Security mode on the PC page: watches the webcam (in the browser, like
// webcam presence) and, when someone appears, sends one snapshot to the
// server, which forwards it to the owner's phone.

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const FRAME_MS = 500;

export class SecurityWatcher {
  private detector: FaceDetector | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trigger = new IntruderTrigger();

  constructor(private readonly onSnapshot: (jpeg: Blob) => void) {}

  async start(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    this.detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.6,
    });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 5 } });
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  private tick(): void {
    if (!this.detector || !this.video || this.video.readyState < 2) return;
    let seen = false;
    try {
      seen = this.detector.detectForVideo(this.video, performance.now()).detections.length > 0;
    } catch {
      return;
    }
    if (!this.trigger.update(seen, Date.now())) return;
    const canvas = document.createElement("canvas");
    canvas.width = this.video.videoWidth || 640;
    canvas.height = this.video.videoHeight || 480;
    canvas.getContext("2d")?.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => b && this.onSnapshot(b), "image/jpeg", 0.8);
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
