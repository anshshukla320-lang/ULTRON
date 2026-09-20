import { validateRequest } from "twilio";

/** Confirms a webhook request was actually signed by Twilio with our auth
 *  token, not just sent by anyone who found the public tunnel URL. */
export function verifyTwilioSignature(req: Request, bodyParams: URLSearchParams): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!authToken || !publicUrl) return false;

  const signature = req.headers.get("x-twilio-signature") ?? "";
  const reqUrl = new URL(req.url);
  const externalUrl = `${publicUrl}${reqUrl.pathname}${reqUrl.search}`;

  const params: Record<string, string> = {};
  for (const [key, value] of bodyParams) params[key] = value;

  return validateRequest(authToken, signature, externalUrl, params);
}
