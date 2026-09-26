// Runs once when the Next.js server starts (see Next's instrumentation docs).
// Starts ULTRON's background services, which only make sense in the Node.js
// server runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startBackgroundLoop } = await import("./lib/agent/background");
  startBackgroundLoop();
  const { startTelegramBot } = await import("./lib/agent/telegram");
  startTelegramBot();
}
