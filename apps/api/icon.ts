/**
 * BridgePilot 512x512 PNG icon, generated deterministically in code (no binary assets in the repo).
 * Served at /static/icon.png; used as the manifest `image` and the x402 v2 `resource.iconUrl`
 * (the Bazaar does not accept SVG).
 */
import { crc32, deflateSync } from 'node:zlib';

const SIZE = 512;
type RGB = [number, number, number];
const BG: RGB = [10, 16, 34];
const LEFT: RGB = [0, 82, 255]; // Base blue
const RIGHT: RGB = [40, 160, 240]; // Arbitrum-ish blue
const ARC: RGB = [235, 240, 252];
const WATER: RGB = [22, 40, 78];

function pixel(x: number, py: number): RGB {
  let y = py;
  // Rounded-square background.
  const r = 96;
  const cx = Math.min(Math.max(x, r), SIZE - 1 - r);
  const cy = Math.min(Math.max(y, r), SIZE - 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0];
  y += 60; // centre the drawing vertically
  // Two chain "nodes" (circles) joined by a bridge arc.
  const node = (nx: number, ny: number) => (x - nx) ** 2 + (y - ny) ** 2 <= 58 ** 2;
  if (node(120, 330)) return LEFT;
  if (node(392, 330)) return RIGHT;
  // Arc: ring segment of a circle centred below the deck.
  const ax = 256, ay = 420, d = Math.sqrt((x - ax) ** 2 + (y - ay) ** 2);
  if (y < 330 && d >= 180 && d <= 204) return ARC;
  // Deck and hangers.
  if (y >= 322 && y <= 338 && x >= 120 && x <= 392) return ARC;
  if (y < 322 && Math.abs(((x - 256 + 1000) % 40) - 20) >= 17 && d < 180 && x > 170 && x < 342) return ARC;
  // Water lines.
  if (y > 410 && y < 418 && x > 90 && x < 422) return WATER;
  return BG;
}

function chunk(tag: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let cached: Buffer | undefined;
export function iconPng(): Buffer {
  if (cached) return cached;
  const rows = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    rows[o++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = pixel(x, y);
      rows[o++] = r; rows[o++] = g; rows[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  cached = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  return cached;
}
