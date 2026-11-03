import fs from 'node:fs';
const f = process.argv[2];
const b = fs.readFileSync(f);
const head = b.subarray(0, Math.min(b.length, 1 << 20));
let seg = null, p = 2;
while (p + 4 <= head.length) {
  if (head[p] !== 0xff) { p++; continue; }
  const m = head[p + 1];
  if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
  if (m === 0xda || m === 0xd9) break;
  const len = head.readUInt16BE(p + 2);
  if (m === 0xe1 && head.toString('latin1', p + 4, p + 8) === 'Exif') { seg = { start: p + 4 + 6, end: p + 2 + len }; break; }
  p += 2 + len;
}
if (!seg) { console.log('无 Exif'); process.exit(0); }
const buf = head.subarray(seg.start, seg.end);
const order = buf.toString('latin1', 0, 2);
const rd16 = (o) => (order === 'II' ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
const rd32 = (o) => (order === 'II' ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
console.log(`字节序=${order} 魔数=${rd16(2)} IFD0偏移=${rd32(4)} Exif段长=${seg.end - seg.start}`);
const NAMES = { 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'DateTime', 0x8769: 'ExifIFD', 0x8825: 'GPSIFD', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0xa002: 'PixelX', 0xa003: 'PixelY', 0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8827: 'ISO', 0x920a: 'FocalLength', 0x0100: 'ImageWidth', 0x0101: 'ImageLength' };
function dump(off, label) {
  if (off < 0 || off + 2 > buf.length) { console.log(`\n[${label}] 偏移 ${off} 越界，跳过`); return; }
  const n = rd16(off);
  console.log(`\n[${label}] IFD@${off} 条目数=${n}`);
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    if (e + 12 > buf.length) { console.log('  越界'); break; }
    const tag = rd16(e), type = rd16(e + 2), count = rd32(e + 4);
    const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 })[type] * count;
    const vo = size <= 4 ? e + 8 : rd32(e + 8);
    let val = '';
    if (vo + size <= buf.length) {
      if (type === 2) val = JSON.stringify(buf.toString('latin1', vo, vo + size).replace(/\0+$/, ''));
      else if (type === 5 || type === 10) { const a = []; for (let k = 0; k < count; k++) { const o = vo + k * 8; const num = order === 'II' ? buf.readUInt32LE(o) : buf.readUInt32BE(o); const den = order === 'II' ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o + 4); a.push(num + '/' + den + '=' + (den ? (num / den).toFixed(3) : 'NaN')); } val = a.join(', '); }
      else if (count === 1) val = String(type === 3 ? rd16(vo) : type === 1 || type === 7 ? buf[vo] : rd32(vo));
    }
    console.log(`  0x${tag.toString(16).padStart(4, '0')} ${(NAMES[tag] || '?').padEnd(18)} type=${type} count=${count}  ${val}`);
  }
}
const ifd0 = rd32(4);
dump(ifd0, 'IFD0');
// 找 ExifIFD / GPS 指针
const n0 = rd16(ifd0);
for (let i = 0; i < n0; i++) {
  const e = ifd0 + 2 + i * 12;
  const tag = rd16(e);
  if (tag === 0x8769) dump(rd32(e + 8), 'ExifIFD');
  if (tag === 0x8825) dump(rd32(e + 8), 'GPS');
}
