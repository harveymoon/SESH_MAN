// Generates assets/icon.ico (multi-size) and assets/icon.png with no external
// image tools. The ">_<" mark is rasterized FRESH at each size (16..256) so
// small icons stay crisp instead of being one 256 bitmap downscaled.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [10, 10, 11];
const FRAME = [42, 45, 51];
const ACCENT = [143, 182, 173];

// ---- draw the mark into an RGBA buffer at a given square size ----
function renderRGBA(S) {
  const buf = Buffer.alloc(S * S * 4);
  const k = S / 256; // scale all 256-space coordinates to this size

  const px = (x, y, c, a = 255) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    buf[i + 3] = a;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) px(x, y, c);
  };
  const frame = (x0, y0, x1, y1, t, c) => {
    rect(x0, y0, x1, y0 + t, c);
    rect(x0, y1 - t, x1, y1, c);
    rect(x0, y0, x0 + t, y1, c);
    rect(x1 - t, y0, x1, y1, c);
  };
  const line = (x0, y0, x1, y1, w, c) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
    const h = w / 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      rect(x0 + (x1 - x0) * t - h, y0 + (y1 - y0) * t - h, x0 + (x1 - x0) * t + h, y0 + (y1 - y0) * t + h, c);
    }
  };

  rect(0, 0, S, S, BG);
  frame(14 * k, 14 * k, 242 * k, 242 * k, Math.max(1, Math.round(3 * k)), FRAME);
  const W = Math.max(2, 18 * k);
  // left ">" eye
  line(64 * k, 84 * k, 114 * k, 130 * k, W, ACCENT);
  line(114 * k, 130 * k, 64 * k, 176 * k, W, ACCENT);
  // right "<" eye
  line(192 * k, 84 * k, 142 * k, 130 * k, W, ACCENT);
  line(142 * k, 130 * k, 192 * k, 176 * k, W, ACCENT);
  // "_" mouth
  rect(106 * k, 176 * k, 150 * k, 192 * k, ACCENT);
  return buf;
}

// ---- PNG encoding ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(buf, S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- multi-image ICO (each entry is a PNG; Vista+ supports PNG-in-ICO) ----
function buildICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  const datas = [];
  let offset = 6 + count * 16;
  for (const im of images) {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size; // 0 means 256
    e[1] = im.size >= 256 ? 0 : im.size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(im.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    datas.push(im.png);
    offset += im.png.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

// ---- build & write ----
const images = SIZES.map((size) => ({ size, png: encodePNG(renderRGBA(size), size) }));
const ico = buildICO(images);
const png256 = images.find((i) => i.size === 256).png;

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
console.log(
  'wrote assets/icon.ico (' + ico.length + 'b, sizes ' + SIZES.join('/') + ') and assets/icon.png'
);
