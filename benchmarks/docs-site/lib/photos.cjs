// Writes 4 deterministic, photo-like 1600x1000 PNGs (gradients + soft noise + a few shapes) for
// the docs-site benchmark. Convert them to JPEG with: sips -s format jpeg -s formatOptions 82
// Usage: node make-photos.cjs <outDir>
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const W = 1600;
const H = 1000;
const out = path.resolve(process.argv[2]);
fs.mkdirSync(out, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const palettes = [
  [[22, 60, 110], [240, 170, 90]],
  [[18, 90, 70], [220, 230, 160]],
  [[90, 30, 80], [250, 140, 120]],
  [[40, 40, 48], [150, 190, 230]],
];

palettes.forEach(([a, b], n) => {
  const r = rng(1000 + n);
  const blobs = Array.from({ length: 7 }, () => ({ x: r() * W, y: r() * H, rad: 80 + r() * 260, k: 0.25 + r() * 0.5 }));
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x / W) * 0.6 + (y / H) * 0.4;
      let light = 0;
      for (const bl of blobs) {
        const d = Math.hypot(x - bl.x, y - bl.y) / bl.rad;
        if (d < 1) light += (1 - d * d) * bl.k;
      }
      const noise = (r() - 0.5) * 7;
      for (let c = 0; c < 3; c++) {
        const v = a[c] + (b[c] - a[c]) * t + light * 70 + noise;
        raw[o++] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(out, `photo-${n + 1}.png`), png);
});
console.log("wrote 4 PNGs to", out);
