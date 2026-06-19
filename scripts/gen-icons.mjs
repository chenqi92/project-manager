// 零依赖生成扩展图标（品牌色圆角方块 + 白色钥匙孔）。
// 直接用 node:zlib 手写 PNG 编码，避免引入图形库依赖。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icon');
mkdirSync(outDir, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

function insideRoundRect(px, py, x1, y1, r) {
  if (px < 0 || py < 0 || px > x1 || py > y1) return false;
  if (px < r && py < r) return dist(px, py, r, r) <= r;
  if (px > x1 - r && py < r) return dist(px, py, x1 - r, r) <= r;
  if (px < r && py > y1 - r) return dist(px, py, r, y1 - r) <= r;
  if (px > x1 - r && py > y1 - r) return dist(px, py, x1 - r, y1 - r) <= r;
  return true;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    const ba = buf[i + 3] / 255;
    const outA = sa + ba * (1 - sa);
    if (outA <= 0) return;
    buf[i] = Math.round((r * sa + buf[i] * ba * (1 - sa)) / outA);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * ba * (1 - sa)) / outA);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * ba * (1 - sa)) / outA);
    buf[i + 3] = Math.round(outA * 255);
  };

  const radius = size * 0.22;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (insideRoundRect(x + 0.5, y + 0.5, size, size, radius)) set(x, y, 79, 70, 229, 255);

  // 钥匙孔：圆 + 倒梯形柄
  const cx = size / 2;
  const cy = size * 0.42;
  const cr = size * 0.16;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (dist(x + 0.5, y + 0.5, cx, cy) <= cr) set(x, y, 255, 255, 255, 255);
    }
  const top = cy;
  const bot = size * 0.74;
  const halfTop = size * 0.045;
  const halfBot = size * 0.1;
  for (let y = Math.floor(top); y < bot; y++) {
    const t = (y - top) / (bot - top);
    const half = halfTop + (halfBot - halfTop) * t;
    for (let x = Math.floor(cx - half); x < cx + half; x++) set(x, y, 255, 255, 255, 255);
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `${size}.png`), encodePng(size, render(size)));
  console.log(`icon/${size}.png`);
}
