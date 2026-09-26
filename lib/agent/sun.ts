// Sunrise and sunset for a place and day, from the standard sunrise
// equation (accurate to a minute or two) — no API needed.

const RAD = Math.PI / 180;
const J2000 = 2451545;

function toJulian(ms: number): number {
  return ms / 86_400_000 + 2440587.5;
}

function fromJulian(j: number): Date {
  return new Date((j - 2440587.5) * 86_400_000);
}

/** `day` is any moment on the wanted day (local time); longitude is east-positive. */
export function sunTimes(day: Date, latitude: number, longitude: number): { sunrise: Date; sunset: Date } | null {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const n = Math.round(toJulian(noon.getTime()) - J2000 + 0.0008);
  const jStar = n - longitude / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const c = 1.9148 * Math.sin(m * RAD) + 0.02 * Math.sin(2 * m * RAD) + 0.0003 * Math.sin(3 * m * RAD);
  const lambda = (m + c + 180 + 102.9372) % 360;
  const transit = J2000 + jStar + 0.0053 * Math.sin(m * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(latitude * RAD) * Math.sin(decl)) / (Math.cos(latitude * RAD) * Math.cos(decl));
  if (cosW < -1 || cosW > 1) return null; // midnight sun / polar night
  const w = Math.acos(cosW) / RAD;
  return { sunrise: fromJulian(transit - w / 360), sunset: fromJulian(transit + w / 360) };
}
