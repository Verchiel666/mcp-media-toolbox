#!/usr/bin/env node
/**
 * 生成测试素材 —— 仓库里不保存任何第三方二进制，避免许可问题。
 *
 *   fixtures/sample.mp4          合成的 ISO-BMFF：640x360 @30fps 视频轨 + 48kHz 2ch AAC 音频轨
 *   fixtures/synthetic-exif.jpg  合成的 EXIF 段（含 Make/Model/DateTimeOriginal/GPS）
 *
 * 注意：sample.mp4 是**结构合法但像素/采样数据是占位字节**的文件，只用于验证解析器，
 * 不是可播放的视频；synthetic-exif.jpg 同理，只验证 APP1 解析，不是可解码图像。
 * 用 `node scripts/make-fixtures.mjs` 重新生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

// ── ISO-BMFF 构造工具 ─────────────────────────────────────────────
const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const str = (s) => Buffer.from(s, 'latin1');
const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([u32(8 + body.length), str(type), body]);
};
const fullBox = (type, version, flags, ...parts) =>
  box(type, u8(version), u24(flags), ...parts);

const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

// ── 时间参数（解析器断言用这些值）─────────────────────────────────
const A = { mvhdTimescale: 1000, mvhdDuration: 13347 };
const V = { timescale: 30, samples: 400, delta: 1, width: 640, height: 360, sampleSize: 100 };
const S = { timescale: 48000, samples: 626, delta: 1024, sampleSize: 200, channels: 2, sfIndex: 3 };

function mvhd() {
  return fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(A.mvhdTimescale), u32(A.mvhdDuration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    MATRIX, Buffer.alloc(24), u32(3));
}

function tkhd(trackId, duration, volume, width, height) {
  return fullBox('tkhd', 0, 3,
    u32(0), u32(0), u32(trackId), u32(0), u32(duration),
    Buffer.alloc(8), u16(0), u16(0), u16(volume), u16(0),
    MATRIX, u32(width * 65536), u32(height * 65536));
}

const mdhd = (timescale, duration) => fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
const hdlr = (type, name) => fullBox('hdlr', 0, 0, u32(0), str(type), Buffer.alloc(12), str(name), u8(0));
const dinf = () => box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
const stts1 = (count, delta) => fullBox('stts', 0, 0, u32(1), u32(count), u32(delta));
const stsc1 = (samplesPerChunk) => fullBox('stsc', 0, 0, u32(1), u32(1), u32(samplesPerChunk), u32(1));
const stszUniform = (size, count) => fullBox('stsz', 0, 0, u32(size), u32(count));
const stco1 = (offset) => fullBox('stco', 0, 0, u32(1), u32(offset));

function videoStsd() {
  const entry = box('avc1',
    Buffer.alloc(6), u16(1),                 // reserved + data_reference_index
    u16(0), u16(0), Buffer.alloc(12),        // pre_defined / reserved / pre_defined[3]
    u16(V.width), u16(V.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1),
    Buffer.alloc(32), u16(0x0018), u16(0xffff));
  return fullBox('stsd', 0, 0, u32(1), entry);
}

function audioStsd() {
  const asc = Buffer.from([0x11, 0x90]); // AOT=2(AAC-LC) sfIndex=3(48k) channels=2
  const dsi = Buffer.concat([u8(0x05), u8(asc.length), asc]);
  const dcd = Buffer.concat([u8(0x04), u8(13 + dsi.length), u8(0x40), u8(0x15), u24(0), u32(0), u32(128000), dsi]);
  const es = Buffer.concat([u8(0x03), u8(3 + dcd.length), u16(1), u8(0), dcd]);
  const esds = fullBox('esds', 0, 0, es);
  const entry = box('mp4a',
    Buffer.alloc(6), u16(1),
    u32(0), u32(0),                          // version/revision/vendor
    u16(S.channels), u16(16), u16(0), u16(0),
    u32(S.timescale * 65536),
    esds);
  return fullBox('stsd', 0, 0, u32(1), entry);
}

function trak(kind, chunkOffset) {
  const isVideo = kind === 'video';
  const t = isVideo ? V : S;
  const duration = isVideo ? V.samples * V.delta : S.samples * S.delta;
  const trakDur = Math.round((duration / t.timescale) * A.mvhdTimescale);
  const stbl = box('stbl',
    isVideo ? videoStsd() : audioStsd(),
    stts1(t.samples, t.delta),
    stsc1(t.samples),
    stszUniform(isVideo ? V.sampleSize : S.sampleSize, t.samples),
    stco1(chunkOffset));
  const minf = box('minf',
    isVideo ? fullBox('vmhd', 0, 1, Buffer.alloc(8)) : fullBox('smhd', 0, 0, Buffer.alloc(4)),
    dinf(), stbl);
  return box('trak',
    tkhd(isVideo ? 1 : 2, trakDur, isVideo ? 0 : 0x0100, isVideo ? V.width : 0, isVideo ? V.height : 0),
    box('mdia', mdhd(t.timescale, duration), hdlr(isVideo ? 'vide' : 'soun', isVideo ? 'VideoHandler' : 'SoundHandler'), minf));
}

function build(videoOffset, audioOffset) {
  const moov = box('moov', mvhd(), trak('video', videoOffset), trak('audio', audioOffset));
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const videoLen = V.samples * V.sampleSize;
  const audioLen = S.samples * S.sampleSize;
  const mdat = box('mdat', Buffer.alloc(videoLen), Buffer.alloc(audioLen));
  return { ftyp, moov, mdat };
}

// moov 里的偏移是固定 4 字节，所以先建一遍量尺寸，再填真偏移重建
const probe = build(0, 0);
const mdatStart = probe.ftyp.length + probe.moov.length;
const videoDataStart = mdatStart + 8;
const audioDataStart = videoDataStart + V.samples * V.sampleSize;
const real = build(videoDataStart, audioDataStart);
if (real.moov.length !== probe.moov.length) throw new Error('moov 尺寸不稳定，偏移计算失效');
const mp4 = Buffer.concat([real.ftyp, real.moov, real.mdat]);
fs.writeFileSync(path.join(OUT, 'sample.mp4'), mp4);
console.log(`fixtures/sample.mp4            ${mp4.length} B  视频 640x360@30 / 音频 48kHz 2ch，时长 ${(A.mvhdDuration / A.mvhdTimescale).toFixed(3)}s`);

// ── EXIF（大端 TIFF，塞进 APP1）───────────────────────────────────
function buildExifJpeg() {
  const entries = []; // {tag, type, count, value:Buffer}
  const ascii = (s) => { const b = Buffer.from(s, 'latin1'); return Buffer.concat([b, Buffer.alloc(b.length % 2 === 0 ? 2 : 1)]); };
  const rat = (n, d) => { const b = Buffer.alloc(8); b.writeUInt32BE(n, 0); b.writeUInt32BE(d, 4); return b; };
  const sh = (n) => u16(n);
  const lg = (n) => u32(n);

  const ifd0 = [
    { tag: 0x010f, type: 2, count: 5, data: ascii('NIKON') },
    { tag: 0x0110, type: 2, count: 13, data: ascii('COOLPIX P6000') },
    { tag: 0x0112, type: 3, count: 1, data: sh(1) },
    { tag: 0x0132, type: 2, count: 20, data: ascii('2008:10:22 16:28:39') },
  ];
  const exifIfd = [
    { tag: 0x829a, type: 5, count: 1, data: rat(1, 75) },
    { tag: 0x829d, type: 5, count: 1, data: rat(59, 10) },
    { tag: 0x8827, type: 3, count: 1, data: sh(64) },
    { tag: 0x9003, type: 2, count: 20, data: ascii('2008:10:22 16:28:39') },
    { tag: 0x920a, type: 5, count: 1, data: rat(240, 10) },
    { tag: 0xa002, type: 4, count: 1, data: lg(640) },
    { tag: 0xa003, type: 4, count: 1, data: lg(480) },
  ];
  const gpsIfd = [
    { tag: 0x0001, type: 2, count: 2, data: ascii('N') },
    { tag: 0x0002, type: 5, count: 3, data: Buffer.concat([rat(43, 1), rat(28, 1), rat(278125, 10000)]) },
    { tag: 0x0003, type: 2, count: 2, data: ascii('E') },
    { tag: 0x0004, type: 5, count: 3, data: Buffer.concat([rat(11, 1), rat(53, 1), rat(1064, 10000)]) },
  ];

  // 三段 IFD 顺序排布：IFD0 → ExifIFD → GPS IFD → 值区
  const sizeOf = (list) => 2 + list.length * 12 + 4;
  const ifd0Off = 8;
  const exifOff = ifd0Off + sizeOf(ifd0) + 2 * 12; // IFD0 里要多放 ExifIFD/GPS 两个指针，各 12 字节
  const gpsOff = exifOff + sizeOf(exifIfd);
  let valueOff = gpsOff + sizeOf(gpsIfd);

  const parts = [];
  const writeIfd = (list, extraPointers) => {
    const total = list.length + extraPointers.length;
    const buf = Buffer.alloc(2 + total * 12 + 4);
    buf.writeUInt16BE(total, 0);
    let i = 0;
    const all = [...list, ...extraPointers].sort((a, b) => a.tag - b.tag);
    for (const e of all) {
      const o = 2 + i * 12;
      buf.writeUInt16BE(e.tag, o);
      buf.writeUInt16BE(e.type, o + 2);
      buf.writeUInt32BE(e.count, o + 4);
      if (e.data.length <= 4) {
        e.data.copy(buf, o + 8);
      } else {
        buf.writeUInt32BE(valueOff, o + 8);
        parts.push({ at: valueOff, data: e.data });
        valueOff += e.data.length;
        if (valueOff % 2) valueOff++;
      }
      i++;
    }
    return buf;
  };

  const ifd0Buf = writeIfd(ifd0, [
    { tag: 0x8769, type: 4, count: 1, data: lg(exifOff) },
    { tag: 0x8825, type: 4, count: 1, data: lg(gpsOff) },
  ]);
  const exifBuf = writeIfd(exifIfd, []);
  const gpsBuf = writeIfd(gpsIfd, []);

  const tiffSize = valueOff;
  const tiff = Buffer.alloc(tiffSize);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0Off, 4);
  ifd0Buf.copy(tiff, ifd0Off);
  exifBuf.copy(tiff, exifOff);
  gpsBuf.copy(tiff, gpsOff);
  for (const p of parts) p.data.copy(tiff, p.at);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(payload.length + 2), payload]);
  // 极简 JPEG 外壳：SOI + APP1 + EOI（只用于验证 APP1 解析，不追求可解码）
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

const jpg = buildExifJpeg();
fs.writeFileSync(path.join(OUT, 'synthetic-exif.jpg'), jpg);
console.log(`fixtures/synthetic-exif.jpg    ${jpg.length} B  NIKON COOLPIX P6000 / 2008-10-22 / GPS 43.474392,11.883363`);
