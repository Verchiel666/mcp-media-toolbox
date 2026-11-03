#!/usr/bin/env node
/**
 * Node7-Media-Toolbox —— 零依赖 MCP Server（Node.js 版，可在 Android 上跑）
 *
 * 对应公众号文章《为什么我说 MCP 是今年最值得花 10 分钟搞懂的技术？》里的
 * Python + FastMCP + ffmpeg 版音视频工具箱，本文件是它在「无 Python、无 ffmpeg、
 * 禁止执行私有目录二进制」的 Android 手机上的等价实现：
 *
 *   文章的工具            本文件的工具          实现方式
 *   get_video_info    ->  get_video_info       纯 JS 解析 ISO-BMFF(mp4/mov/m4a) + 图片头
 *   extract_audio_wav ->  extract_audio_track  纯 JS 拆 stco/stsc/stsz + 手工打 ADTS 头
 *   get_system_hardware-> get_system_hardware  os / 内存 / 磁盘 / 运行时
 *
 * 协议实现要点（按 MCP 2025-06-18 规范）：
 *   - 传输层 stdio：一行一条 JSON-RPC 消息，stdout 只允许出现 MCP 消息
 *   - 生命周期：initialize -> notifications/initialized -> tools/list -> tools/call
 *   - 禁止 print 到 stdout（调试全走 stderr），否则客户端 JSON 解析器当场爆炸
 */

import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';

const SERVER_NAME = 'node7-media-toolbox';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const AUDIO_FORMATS = ['mp4a', 'Opus', 'ac-3', 'ec-3', 'alac', 'fLaC', 'samr', 'sowt', 'twos', 'lpcm', 'ulaw', 'alaw'];

const log = (...a) => process.stderr.write('[mcp-server] ' + a.join(' ') + '\n');

/* ============================ 1. ISO-BMFF (mp4/mov) 解析 ============================ */

function scanBoxesOnDisk(fd, fileSize) {
  const out = [];
  let off = 0;
  const hdr = Buffer.alloc(16);
  while (off + 8 <= fileSize) {
    const n = fs.readSync(fd, hdr, 0, 16, off);
    if (n < 8) break;
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString('latin1', 4, 8);
    let hs = 8;
    if (size === 1) {
      if (n < 16) break;
      size = Number(hdr.readBigUInt64BE(8));
      hs = 16;
    } else if (size === 0) {
      size = fileSize - off;
    }
    if (size < hs || off + size > fileSize) {
      log('box ' + type + ' 尺寸异常(size=' + size + ')，停止扫描');
      break;
    }
    out.push({ type, start: off, bodyStart: off + hs, end: off + size, size });
    off += size;
  }
  return out;
}

/** 在内存里切分子 box（处理 64 位 size 与 size=0 两种边界） */
function boxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hs = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      hs = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hs || off + size > end) break;
    out.push({ type, start: off, bodyStart: off + hs, end: off + size });
    off += size;
  }
  return out;
}

const find = (arr, t) => (arr || []).find((b) => b.type === t);
const shift = (arr, t) => (arr || []).filter((b) => b.type === t);

function readFull(fd, start, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, start);
  return n === len ? b : b.subarray(0, n);
}

function parseMvhd(buf, box) {
  const p = box.bodyStart;
  if (buf[p] === 1) {
    return { timescale: buf.readUInt32BE(p + 20), duration: Number(buf.readBigUInt64BE(p + 24)) };
  }
  return { timescale: buf.readUInt32BE(p + 12), duration: buf.readUInt32BE(p + 16) };
}

function parseTkhd(buf, box) {
  const p = box.bodyStart;
  const v = buf[p];
  const end = box.end;
  const width = Math.round(buf.readUInt32BE(end - 8) / 65536);
  const height = Math.round(buf.readUInt32BE(end - 4) / 65536);
  const volOff = v === 1 ? p + 48 : p + 36;
  const volume = volOff + 2 <= end ? buf.readUInt16BE(volOff) / 256 : null;
  const trackId = v === 1 ? buf.readUInt32BE(p + 20) : buf.readUInt32BE(p + 12);
  return { trackId, width, height, volume };
}

function parseMdhd(buf, box) {
  const p = box.bodyStart;
  if (buf[p] === 1) {
    return { timescale: buf.readUInt32BE(p + 20), duration: Number(buf.readBigUInt64BE(p + 24)) };
  }
  return { timescale: buf.readUInt32BE(p + 12), duration: buf.readUInt32BE(p + 16) };
}

function parseStts(buf, box) {
  const p = box.bodyStart;
  const count = buf.readUInt32BE(p + 4);
  let samples = 0;
  let ticks = 0;
  const groups = [];
  for (let i = 0; i < count; i++) {
    const o = p + 8 + i * 8;
    if (o + 8 > box.end) break;
    const n = buf.readUInt32BE(o);
    const d = buf.readUInt32BE(o + 4);
    samples += n;
    ticks += n * d;
    if (groups.length < 4) groups.push({ count: n, delta: d });
  }
  return { count, samples, ticks, groups };
}

function parseStsz(buf, box) {
  const p = box.bodyStart;
  const uniform = buf.readUInt32BE(p + 4);
  const count = buf.readUInt32BE(p + 8);
  if (uniform !== 0) return { count, uniform, sizes: null, total: uniform * count };
  let total = 0;
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = p + 12 + i * 4;
    if (o + 4 > box.end) { sizes.length = i; break; }
    sizes[i] = buf.readUInt32BE(o);
    total += sizes[i];
  }
  return { count: sizes.length, uniform: 0, sizes, total };
}

function parseStco(buf, box) {
  const p = box.bodyStart;
  const count = buf.readUInt32BE(p + 4);
  const is64 = box.type === 'co64';
  const step = is64 ? 8 : 4;
  const offs = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = p + 8 + i * step;
    if (o + step > box.end) { offs.length = i; break; }
    offs[i] = is64 ? Number(buf.readBigUInt64BE(o)) : buf.readUInt32BE(o);
  }
  return offs;
}

function parseStsc(buf, box) {
  const p = box.bodyStart;
  const count = buf.readUInt32BE(p + 4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = p + 8 + i * 12;
    if (o + 12 > box.end) break;
    out.push({
      firstChunk: buf.readUInt32BE(o),
      samplesPerChunk: buf.readUInt32BE(o + 4),
      descIndex: buf.readUInt32BE(o + 8),
    });
  }
  return out;
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function readDescriptor(buf, pos, limit) {
  if (pos >= limit) return null;
  const tag = buf[pos++];
  let len = 0;
  let b;
  let guard = 0;
  do {
    if (pos >= limit || guard++ > 4) return null;
    b = buf[pos++];
    len = (len << 7) | (b & 0x7f);
  } while (b & 0x80);
  return { tag, len, bodyStart: pos, end: Math.min(pos + len, limit) };
}

/** esds -> ES_Descriptor -> DecoderConfigDescriptor -> DecoderSpecificInfo(AudioSpecificConfig) */
function parseEsds(buf, esds) {
  const limit = esds.end;
  const es = readDescriptor(buf, esds.bodyStart + 4, limit);
  if (!es || es.tag !== 0x03) return null;
  let q = es.bodyStart + 2;
  const flags = buf[q++];
  if (flags & 0x80) q += 2;
  if (flags & 0x40) q += 1 + buf[q];
  if (flags & 0x20) q += 2;
  const dcd = readDescriptor(buf, q, es.end);
  if (!dcd || dcd.tag !== 0x04) return null;
  const objectTypeIndication = buf[dcd.bodyStart];
  const dsi = readDescriptor(buf, dcd.bodyStart + 13, dcd.end);
  if (!dsi || dsi.tag !== 0x05) return { objectTypeIndication };
  const asc = buf.subarray(dsi.bodyStart, dsi.end);
  let bit = 0;
  const rb = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[bit >> 3] || 0;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const audioObjectType = rb(5);
  const sfIndex = rb(4);
  const freq = sfIndex === 15 ? rb(24) : SAMPLE_RATES[sfIndex] || 0;
  const channelConfig = rb(4);
  return { objectTypeIndication, audioObjectType, sfIndex, freq, channelConfig };
}

/** 解析 stsd 里的 sample entry */
function parseStsd(buf, box) {
  const entries = [];
  let off = box.bodyStart + 8;
  while (off + 8 <= box.end) {
    const size = buf.readUInt32BE(off);
    const format = buf.toString('latin1', off + 4, off + 8);
    if (size < 8 || off + size > box.end) break;
    const e = { format, width: 0, height: 0, channels: 0, sampleRate: 0, asc: null };
    if (AUDIO_FORMATS.includes(format)) {
      e.channels = buf.readUInt16BE(off + 24);
      e.sampleRate = buf.readUInt32BE(off + 32) >>> 16;
      const kids = boxes(buf, off + 36, off + size);
      const esds = find(kids, 'esds');
      if (esds) e.asc = parseEsds(buf, esds);
      const dOps = find(kids, 'dOps');
      if (dOps && dOps.size >= 11) {
        e.channels = buf[dOps.bodyStart + 1];
        const r = buf.readUInt32BE(dOps.bodyStart + 4);
        if (r > 0) e.sampleRate = r;
      }
    } else {
      e.width = buf.readUInt16BE(off + 32);
      e.height = buf.readUInt16BE(off + 34);
    }
    entries.push(e);
    off += size;
  }
  return entries;
}

function loadMoov(fd, fileSize) {
  const top = scanBoxesOnDisk(fd, fileSize);
  const moov = find(top, 'moov');
  if (!moov) return { top, moovBuf: null, moov: null };
  if (moov.size > 32 * 1024 * 1024) throw new Error('moov 过大，拒绝加载');
  return { top, moovBuf: readFull(fd, moov.start, moov.size), moov };
}

function probeMp4(fd, fileSize) {
  const loaded = loadMoov(fd, fileSize);
  if (!loaded.moov) return null;
  const buf = loaded.moovBuf;
  const moov = loaded.moov;
  // 注意：moov.bodyStart / moov.end 是「文件内偏移」，而 buf 是 moov 的内存副本，
  // 必须换算成缓冲区偏移，否则 readUInt32BE 会越界。
  const moovBodyStart = moov.bodyStart - moov.start;
  const kids = boxes(buf, moovBodyStart, moov.size);

  const ftypBox = find(loaded.top, 'ftyp');
  let brand = null;
  const compatible = [];
  if (ftypBox) {
    const f = readFull(fd, ftypBox.bodyStart, Math.min(ftypBox.size - 8, 64));
    brand = f.toString('latin1', 0, 4);
    for (let i = 8; i + 4 <= f.length; i += 4) compatible.push(f.toString('latin1', i, i + 4));
  }

  const mvhd = find(kids, 'mvhd');
  const header = mvhd ? parseMvhd(buf, mvhd) : { timescale: 0, duration: 0 };
  const durationSec = header.timescale ? header.duration / header.timescale : 0;

  const tracks = [];
  for (const trak of shift(kids, 'trak')) {
    const tk = boxes(buf, trak.bodyStart, trak.end);
    const tkhdBox = find(tk, 'tkhd');
    const tkhd = tkhdBox ? parseTkhd(buf, tkhdBox) : { width: 0, height: 0, trackId: 0 };
    const mdia = find(tk, 'mdia');
    if (!mdia) continue;
    const md = boxes(buf, mdia.bodyStart, mdia.end);
    const hdlr = find(md, 'hdlr');
    const handler = hdlr ? buf.toString('latin1', hdlr.bodyStart + 8, hdlr.bodyStart + 12) : '';
    const mdhdBox = find(md, 'mdhd');
    const mdhd = mdhdBox ? parseMdhd(buf, mdhdBox) : { timescale: 0, duration: 0 };
    const minf = find(md, 'minf');
    const stbl = minf ? find(boxes(buf, minf.bodyStart, minf.end), 'stbl') : null;
    const sb = stbl ? boxes(buf, stbl.bodyStart, stbl.end) : [];
    const stsdBox = find(sb, 'stsd');
    const entries = stsdBox ? parseStsd(buf, stsdBox) : [];
    const sttsBox = find(sb, 'stts');
    const stts = sttsBox ? parseStts(buf, sttsBox) : { samples: 0, ticks: 0, groups: [] };
    const stszBox = find(sb, 'stsz');
    const stsz = stszBox ? parseStsz(buf, stszBox) : { total: 0, count: 0, uniform: 0, sizes: null };
    const stcoBox = find(sb, 'stco') || find(sb, 'co64');
    const chunkOffsets = stcoBox ? parseStco(buf, stcoBox) : [];
    const stscBox = find(sb, 'stsc');
    const stsc = stscBox ? parseStsc(buf, stscBox) : [];
    const trackDur = mdhd.duration && mdhd.timescale ? mdhd.duration / mdhd.timescale : durationSec;
    const entry = entries[0] || { format: '?', width: 0, height: 0, channels: 0, sampleRate: 0, asc: null };
    const t = {
      track_id: tkhd.trackId,
      type: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler,
      codec: entry.format,
      duration_sec: Number(trackDur.toFixed(3)),
      samples: stsz.count || stts.samples,
      bitrate_kbps: trackDur > 0 ? Math.round((stsz.total * 8) / trackDur / 1000) : null,
    };
    if (handler === 'vide') {
      t.width = entry.width || tkhd.width;
      t.height = entry.height || tkhd.height;
      t.fps = trackDur > 0 ? Number((stts.samples / trackDur).toFixed(2)) : null;
      t.frame_time_groups = stts.groups.map((g) => g.count + 'x' + g.delta);
      if (mdhd.timescale && stts.groups[0]) {
        t.fps_by_timescale = Number((mdhd.timescale / stts.groups[0].delta).toFixed(3));
      }
    }
    if (handler === 'soun') {
      t.channels = entry.channels;
      t.sample_rate = entry.sampleRate;
      if (entry.asc) {
        t.aac = {
          audio_object_type: entry.asc.audioObjectType,
          sf_index: entry.asc.sfIndex,
          freq: entry.asc.freq,
          channel_config: entry.asc.channelConfig,
        };
      }
    }
    Object.defineProperty(t, '_raw', {
      value: { stsz, chunkOffsets, stsc, asc: entry.asc, codec: entry.format },
      enumerable: false,
    });
    tracks.push(t);
  }
  return {
    container: { brand, compatible_brands: compatible },
    duration_sec: Number(durationSec.toFixed(3)),
    tracks,
  };
}

/* ============================ 2. 非 mp4：魔数嗅探 ============================ */

function jpegSize(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && p + 9 < buf.length) return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}

function sniff(fd, fileSize) {
  let head = readFull(fd, 0, Math.min(fileSize, 65536));
  const ascii = (a, b) => head.toString('latin1', a, b);
  const out = { kind: 'unknown', magic_hex: head.subarray(0, 8).toString('hex') };
  if (fileSize > 12 && ascii(4, 8) === 'ftyp') {
    out.kind = 'mp4/mov';
    out.container = 'ISO-BMFF';
    out.brand = ascii(8, 12);
    return out;
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    out.kind = 'jpeg';
    // 手机照片的 EXIF/XMP 可能几十 KB，SOF 落在首窗之外时扩大窗口重扫
    let dim = jpegSize(head);
    if (!dim && fileSize > head.length) dim = jpegSize(readFull(fd, 0, Math.min(fileSize, 8 << 20)));
    if (dim) Object.assign(out, dim);
    return out;
  }
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') {
    out.kind = 'png';
    out.width = head.readUInt32BE(16);
    out.height = head.readUInt32BE(20);
    return out;
  }
  if (ascii(0, 3) === 'GIF') {
    out.kind = 'gif';
    out.width = head.readUInt16LE(6);
    out.height = head.readUInt16LE(8);
    return out;
  }
  if (ascii(0, 4) === 'RIFF') {
    const t = ascii(8, 12);
    out.kind = t === 'WAVE' ? 'wav' : t === 'WEBP' ? 'webp' : 'riff/' + t;
    return out;
  }
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) { out.kind = 'mp3'; return out; }
  if (ascii(0, 4) === 'fLaC') { out.kind = 'flac'; return out; }
  if (ascii(0, 5) === '%PDF-') { out.kind = 'pdf'; return out; }
  if (ascii(0, 2) === 'PK') { out.kind = 'zip/apk/docx'; return out; }
  if (ascii(0, 4) === 'OggS') { out.kind = 'ogg'; return out; }
  return out;
}

/* ============================ 3. 音轨抽取：MP4 -> ADTS AAC ============================ */

function adtsHeader(aot, sfIndex, channels, frameLen) {
  const profile = Math.max(0, Math.min(3, (aot || 2) - 1));
  const b = Buffer.alloc(7);
  b[0] = 0xff;
  b[1] = 0xf1;
  b[2] = (profile << 6) | ((sfIndex & 0x0f) << 2) | ((channels >> 2) & 1);
  b[3] = ((channels & 3) << 6) | ((frameLen >> 11) & 3);
  b[4] = (frameLen >> 3) & 0xff;
  b[5] = ((frameLen & 7) << 5) | 0x1f;
  b[6] = 0xfc;
  return b;
}

function extractAudio(fd, fileSize, outPath) {
  const probe = probeMp4(fd, fileSize);
  if (!probe) throw new Error('不是可解析的 ISO-BMFF 文件（找不到 moov）');
  const track = probe.tracks.find((t) => t.type === 'audio');
  if (!track) throw new Error('该文件里没有音频轨');
  const raw = track._raw || {};
  const stsz = raw.stsz;
  const chunkOffsets = raw.chunkOffsets || [];
  const stsc = raw.stsc || [];
  const asc = raw.asc;
  if (!/^mp4a/.test(raw.codec || '')) throw new Error('音频编码是 ' + raw.codec + '，本实现只支持 AAC(mp4a) 直抽');
  if (!asc || !asc.sfIndex) throw new Error('缺少 esds/AudioSpecificConfig，无法构造 ADTS 头');
  const sizes = stsz.uniform ? new Array(stsz.count).fill(stsz.uniform) : stsz.sizes;
  if (!sizes || !chunkOffsets.length || !stsc.length) throw new Error('缺少 stsz/stco/stsc，无法定位样本');

  const out = fs.openSync(outPath, 'w');
  let sampleIdx = 0;
  let written = 0;
  let frames = 0;
  const spcFor = (chunk1) => {
    let cur = stsc[0];
    for (const e of stsc) if (chunk1 >= e.firstChunk) cur = e;
    return cur.samplesPerChunk;
  };
  try {
    for (let c = 0; c < chunkOffsets.length && sampleIdx < sizes.length; c++) {
      let off = chunkOffsets[c];
      const spc = spcFor(c + 1);
      for (let i = 0; i < spc && sampleIdx < sizes.length; i++) {
        const sz = sizes[sampleIdx];
        if (!sz) { sampleIdx++; continue; }
        const data = readFull(fd, off, sz);
        if (data.length !== sz) throw new Error('读取样本 ' + sampleIdx + ' 失败');
        fs.writeSync(out, adtsHeader(asc.audioObjectType, asc.sfIndex, asc.channelConfig || track.channels || 2, sz + 7));
        fs.writeSync(out, data);
        written += sz + 7;
        frames++;
        off += sz;
        sampleIdx++;
      }
    }
  } finally {
    fs.closeSync(out);
  }
  return {
    output_path: outPath,
    format: 'ADTS AAC (.aac)',
    frames,
    bytes: written,
    sample_rate: asc.freq,
    channels: asc.channelConfig,
    audio_object_type: asc.audioObjectType,
    note: '本机无 ffmpeg：输出为可直接播放的 ADTS AAC 裸流，未做 16kHz 单声道重采样/封装',
  };
}

/* ============================ 4. 工具实现 ============================ */

function toolGetVideoInfo({ file_path }) {
  if (!file_path || typeof file_path !== 'string') throw new Error('缺少参数 file_path');
  const st = fs.statSync(file_path);
  if (!st.isFile()) throw new Error('不是普通文件: ' + file_path);
  const fd = fs.openSync(file_path, 'r');
  try {
    const info = sniff(fd, st.size);
    const result = {
      path: file_path,
      size_bytes: st.size,
      size_human: (st.size / 1048576).toFixed(2) + ' MiB',
      sniffed: info,
    };
    if (info.kind === 'mp4/mov') {
      const probe = probeMp4(fd, st.size);
      if (probe) {
        result.container = probe.container;
        result.duration_sec = probe.duration_sec;
        result.overall_bitrate_kbps = probe.duration_sec > 0 ? Math.round((st.size * 8) / probe.duration_sec / 1000) : null;
        result.streams = probe.tracks.map((t) => {
          const copy = {};
          for (const k of Object.keys(t)) copy[k] = t[k];
          return copy;
        });
        result.video = result.streams.filter((s) => s.type === 'video');
        result.audio = result.streams.filter((s) => s.type === 'audio');
      } else {
        result.warning = 'ftyp 声明是 ISO-BMFF，但没找到 moov（碎片化 mp4 需 ffmpeg）';
      }
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

function toolExtractAudio({ input_path, output_path }) {
  if (!input_path) throw new Error('缺少参数 input_path');
  const out = output_path || input_path.replace(/\.[^.]+$/, '') + '.aac';
  const st = fs.statSync(input_path);
  const fd = fs.openSync(input_path, 'r');
  try {
    return extractAudio(fd, st.size, out);
  } finally {
    fs.closeSync(fd);
  }
}

function toolGetSystemHardware() {
  let disk = null;
  try {
    const s = fs.statfsSync('/sdcard');
    disk = { total_gib: +((s.blocks * s.bsize) / 2 ** 30).toFixed(1), free_gib: +((s.bavail * s.bsize) / 2 ** 30).toFixed(1) };
  } catch (e) {
    log('statfs 失败: ' + e.message);
  }
  const total = os.totalmem();
  const free = os.freemem();
  return {
    host: os.hostname(),
    os: os.type() + ' / ' + os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpus: os.cpus().length || os.availableParallelism(),
    cpu_model: (os.cpus()[0] || {}).model,
    memory: { total_gib: +(total / 2 ** 30).toFixed(2), free_gib: +(free / 2 ** 30).toFixed(2) },
    runtime: { node: process.version, v8: process.versions.v8, libuv: process.versions.uv },
    disk_sdcard: disk,
    mcp_server: { name: SERVER_NAME, version: SERVER_VERSION },
    uptime_sec: Math.round(os.uptime()),
    toolchain_hint: '本机无 python / ffmpeg；Android 禁止执行应用私有目录里的二进制（EACCES），解释器读脚本不受限',
  };
}

const TOOLS = [
  {
    name: 'get_video_info',
    title: '视频/媒体元数据探测',
    description:
      '获取本地媒体文件的容器、时长、视频流（编码/分辨率/帧率/码率）与音频流（编码/声道/采样率/AAC 参数）；对图片返回 JPEG/PNG/GIF 尺寸，其他文件返回魔数嗅探。纯 JS 解析，不需要 ffprobe。参数为本地绝对路径。',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string', description: '本地文件绝对路径，例如 /sdcard/DCIM/a.mp4' } },
      required: ['file_path'],
    },
    handler: toolGetVideoInfo,
  },
  {
    name: 'extract_audio_track',
    title: '抽取视频音轨(ADTS AAC)',
    description:
      '把 mp4/m4a 里的 AAC 音轨按样本表(stsz/stco/stsc)直抽出来，手工构造 ADTS 头写成 .aac 裸流，可直接播放或喂给语音识别。本机无 ffmpeg，故不做重采样/转 WAV。',
    inputSchema: {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: '源视频绝对路径' },
        output_path: { type: 'string', description: '输出 .aac 路径，省略则同目录同名' },
      },
      required: ['input_path'],
    },
    handler: toolExtractAudio,
  },
  {
    name: 'get_system_hardware',
    title: '宿主机硬件/运行时快照',
    description: '获取宿主机 CPU 架构、操作系统、内存、磁盘、Node 运行时版本与 MCP 服务信息，供 Agent 决策本地算力分配。',
    inputSchema: { type: 'object', properties: {} },
    handler: toolGetSystemHardware,
  },
];

/* ============================ 5. JSON-RPC / stdio 传输层 ============================ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg, null, 2) + '\n');
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) =>
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (msg.jsonrpc !== '2.0' || !method) {
    if (!isNotification) fail(id, -32600, 'Invalid Request');
    return;
  }
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL;
      log('initialize: 客户端=' + JSON.stringify((params && params.clientInfo) || {}) + ' 请求版本=' + asked + ' 协商=' + negotiated);
      return reply(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: '第七节点 · 本机媒体工具箱(Node版)', version: SERVER_VERSION },
        instructions:
          '本服务运行在一台 Android 手机上，提供媒体元数据探测、AAC 音轨直抽与硬件快照。工具只读取源文件、只新增输出文件。',
      });
    }
    case 'notifications/initialized':
    case 'initialized':
      log('客户端完成初始化握手 (notifications/initialized)');
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(id, -32602, '未知工具: ' + name);
      const t0 = process.hrtime.bigint();
      try {
        const data = await tool.handler(args);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        log('tools/call ' + name + ' 成功 ' + ms.toFixed(1) + 'ms');
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        });
      } catch (e) {
        log('tools/call ' + name + ' 失败: ' + e.message);
        return reply(id, { content: [{ type: 'text', text: '工具执行失败: ' + e.message }], isError: true });
      }
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      log('收到未实现的方法: ' + method);
      if (!isNotification) fail(id, -32601, 'Method not found: ' + method);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (e) {
    log('收到非法 JSON 行，已丢弃: ' + s.slice(0, 120));
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  Promise.resolve(handle(msg)).catch((e) => {
    log('handle 异常: ' + (e && e.stack));
    if (msg && msg.id != null) fail(msg.id, -32603, 'Internal error', String(e && e.message));
  });
});
rl.on('close', () => {
  log('stdin 关闭，服务退出');
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (e) => {
  log('未捕获异常: ' + (e && e.stack));
  process.exit(1);
});
log('MCP Server「' + SERVER_NAME + '」v' + SERVER_VERSION + ' 已就绪，等待 stdio 上的 JSON-RPC 消息');
