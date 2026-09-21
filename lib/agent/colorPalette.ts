interface HSL {
  h: number;
  s: number;
  l: number;
}

function normalizeHex(input: string): string {
  const hex = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`"${input}" isn't a valid 6-digit hex color, e.g. "#3366ff".`);
  }
  return hex;
}

function hexToHsl(hex: string): HSL {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      break;
    case g:
      h = ((b - r) / d + 2) * 60;
      break;
    default:
      h = ((r - g) / d + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }: HSL): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  const hue = ((h % 360) + 360) % 360;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toByte = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`.toUpperCase();
}

const SCHEME_HUE_OFFSETS: Record<string, number[]> = {
  complementary: [0, 180],
  triadic: [0, 120, 240],
  analogous: [0, -30, 30],
  monochromatic: [0],
};

/**
 * Real color theory, computed locally — no image-gen API involved. Each hue
 * gets a light/base/dark variant so the palette is directly usable (a
 * background, a primary, and an accent/dark shade per hue).
 */
export function generatePalette(baseColor: string, scheme: string): string {
  const key = scheme.trim().toLowerCase();
  const offsets = SCHEME_HUE_OFFSETS[key];
  if (!offsets) {
    throw new Error(`Unknown scheme "${scheme}". Use complementary, analogous, triadic, or monochromatic.`);
  }

  const base = hexToHsl(normalizeHex(baseColor));
  const lines: string[] = [];

  offsets.forEach((offset, i) => {
    const hue = base.h + offset;
    const label = offsets.length === 1 ? "base" : i === 0 ? "primary" : `accent ${i}`;
    const light = hslToHex({ h: hue, s: Math.max(base.s - 15, 20), l: Math.min(base.l + 30, 92) });
    const mid = hslToHex({ h: hue, s: base.s, l: base.l });
    const dark = hslToHex({ h: hue, s: Math.min(base.s + 10, 100), l: Math.max(base.l - 25, 10) });
    lines.push(`${label}: ${light} (light) / ${mid} (base) / ${dark} (dark)`);
  });

  return lines.join("\n");
}
