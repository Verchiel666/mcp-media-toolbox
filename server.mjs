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
import crypto from 'node:crypto';
import readline from 'node:readline';

const SERVER_NAME = 'node7-media-toolbox';
const SERVER_VERSION = '1.3.1';
// 声明支持某个版本 ≠ 实现了它的全部可选特性：icons(SEP-973)、tasks(SEP-1686)、
// elicitation 的 URL 模式等都是能力协商的可选项，本 server 只声明 tools 能力。
// 2025-11-25 对 stdio 传输与 tools 原语是兼容的（新增项均为可选），故可声明。
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-11-25';
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
    const diskRoot = process.env.DSH_MEDIA_DISK_ROOT || '/sdcard';
    const s = fs.statfsSync(diskRoot);
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
    disk: disk ? { root: process.env.DSH_MEDIA_DISK_ROOT || '/sdcard', ...disk } : null,
    mcp_server: { name: SERVER_NAME, version: SERVER_VERSION },
    uptime_sec: Math.round(os.uptime()),
    toolchain_hint: '本机无 python / ffmpeg；Android 禁止执行应用私有目录里的二进制（EACCES），解释器读脚本不受限',
  };
}

/* ============================ 4b. 目录级工具（v1.1 新增） ============================ */

const KIND_BY_EXT = new Map(Object.entries({
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', '3gp': 'video', webm: 'video', ts: 'video',
  m4a: 'audio', mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', amr: 'audio',
  pdf: 'doc', doc: 'doc', docx: 'doc', txt: 'doc', md: 'doc', xls: 'doc', xlsx: 'doc', ppt: 'doc', pptx: 'doc', json: 'doc',
  zip: 'archive', apk: 'archive', rar: 'archive', '7z': 'archive', gz: 'archive', tar: 'archive', xz: 'archive',
}));

const categoryOfFile = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? (KIND_BY_EXT.get(m[1].toLowerCase()) || 'other') : 'other';
};

/** 广度优先遍历，带条目上限，避免在 1GB+ 目录上失控 */
function walkFiles(root, { recursive = true, maxEntries = 20000, maxDepth = 8 } = {}) {
  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  let truncated = false;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      log('跳过不可读目录 ' + dir + ': ' + e.code);
      continue;
    }
    for (const ent of ents) {
      if (out.length >= maxEntries) { truncated = true; break; }
      const p = dir + '/' + ent.name;
      if (ent.isDirectory()) {
        if (recursive && depth < maxDepth && !ent.name.startsWith('.')) queue.push({ dir: p, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(p);
        out.push({ path: p, name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) {
        log('跳过不可读文件 ' + p + ': ' + e.code);
      }
    }
    if (truncated) break;
  }
  return { files: out, truncated };
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

const humanBytes = (b) => {
  if (b >= 2 ** 30) return (b / 2 ** 30).toFixed(2) + ' GiB';
  if (b >= 2 ** 20) return (b / 2 ** 20).toFixed(1) + ' MiB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KiB';
  return b + ' B';
};

/** 目录体检：每个文件的类型/尺寸/时长，外加按类型的汇总 */
function toolProbeDir({ dir_path, limit = 20, sort = 'mtime', recursive = false }) {
  if (!dir_path || typeof dir_path !== 'string') throw new Error('缺少参数 dir_path');
  const st = fs.statSync(dir_path);
  if (!st.isDirectory()) throw new Error('不是目录: ' + dir_path);
  const { files, truncated } = walkFiles(dir_path, { recursive, maxEntries: 5000 });
  const sorted = files.slice().sort((a, b) => (sort === 'size' ? b.size - a.size : b.mtimeMs - a.mtimeMs));
  const cap = Math.max(1, Math.min(Number(limit) || 20, 60));
  const rows = [];
  for (const f of sorted.slice(0, cap)) {
    const row = { name: f.name, size: humanBytes(f.size), size_bytes: f.size, mtime: new Date(f.mtimeMs).toISOString().slice(0, 19) };
    let fd;
    try {
      fd = fs.openSync(f.path, 'r');
      const info = sniff(fd, f.size);
      row.kind = info.kind;
      if (info.width) { row.width = info.width; row.height = info.height; }
      if (info.kind === 'mp4/mov') {
        const probe = probeMp4(fd, f.size);
        if (probe) {
          row.duration_sec = probe.duration_sec;
          const v = probe.tracks.find((t) => t.type === 'video');
          const a = probe.tracks.find((t) => t.type === 'audio');
          if (v) { row.resolution = v.width + 'x' + v.height; row.fps = v.fps; row.video_codec = v.codec; }
          if (a) { row.audio_codec = a.codec; row.sample_rate = a.sample_rate; }
        }
      }
    } catch (e) {
      row.kind = 'unreadable';
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    rows.push(row);
  }
  const byCategory = {};
  let total = 0;
  for (const f of files) {
    const c = categoryOfFile(f.name);
    byCategory[c] = byCategory[c] || { files: 0, bytes: 0 };
    byCategory[c].files++;
    byCategory[c].bytes += f.size;
    total += f.size;
  }
  for (const c of Object.keys(byCategory)) byCategory[c].size = humanBytes(byCategory[c].bytes);
  return {
    dir: dir_path,
    files_count: files.length,
    total: humanBytes(total),
    total_bytes: total,
    truncated,
    by_category: byCategory,
    sorted_by: sort,
    items: rows,
  };
}

/** 空间占用分析：Top 子目录 + 类型分布 + 最大文件 */
function toolStorageReport({ path: root, top = 8, max_entries = 20000 }) {
  if (!root || typeof root !== 'string') throw new Error('缺少参数 path');
  const st = fs.statSync(root);
  if (!st.isDirectory()) throw new Error('不是目录: ' + root);
  const { files, truncated } = walkFiles(root, { maxEntries: Math.min(Number(max_entries) || 20000, 100000) });
  const byDir = new Map();
  const byCat = {};
  let total = 0;
  const prefix = root.replace(/\/+$/, '') + '/';
  for (const f of files) {
    total += f.size;
    const rel = f.path.slice(prefix.length);
    const seg = rel.includes('/') ? rel.split('/')[0] : '(根目录文件)';
    const d = byDir.get(seg) || { dir: seg, bytes: 0, files: 0 };
    d.bytes += f.size;
    d.files++;
    byDir.set(seg, d);
    const c = categoryOfFile(f.name);
    byCat[c] = (byCat[c] || 0) + f.size;
  }
  const dirs = [...byDir.values()].sort((a, b) => b.bytes - a.bytes).slice(0, Math.min(Number(top) || 8, 30));
  const largest = files.slice().sort((a, b) => b.size - a.size).slice(0, 5)
    .map((f) => ({ name: f.path.slice(prefix.length), size: humanBytes(f.size) }));
  const cats = Object.fromEntries(Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, humanBytes(v)]));
  return {
    path: root,
    files_scanned: files.length,
    truncated,
    total: humanBytes(total),
    total_bytes: total,
    top_dirs: dirs.map((d) => ({ dir: d.dir, size: humanBytes(d.bytes), files: d.files, bytes: d.bytes })),
    by_category: cats,
    largest_files: largest,
  };
}

/** 重复文件：先按大小分组，再对候选逐个 sha256，避免无谓的读盘 */
function toolFindDuplicates({ dir_path, min_bytes = 100 * 1024, max_files = 3000 }) {
  if (!dir_path || typeof dir_path !== 'string') throw new Error('缺少参数 dir_path');
  const st = fs.statSync(dir_path);
  if (!st.isDirectory()) throw new Error('不是目录: ' + dir_path);
  const floor = Math.max(0, Number(min_bytes) || 0);
  const { files, truncated } = walkFiles(dir_path, { maxEntries: Math.min(Number(max_files) || 3000, 20000) });
  const bySize = new Map();
  for (const f of files) {
    if (f.size < floor) continue;
    const arr = bySize.get(f.size) || [];
    arr.push(f);
    bySize.set(f.size, arr);
  }
  const groups = [];
  let wasted = 0;
  let hashed = 0;
  let hashErrors = 0;
  for (const [size, arr] of bySize) {
    if (arr.length < 2) continue;
    const byHash = new Map();
    for (const f of arr) {
      let h;
      try { h = sha256File(f.path); hashed++; } catch (e) { hashErrors++; log('哈希失败 ' + f.path + ': ' + e.message); continue; }
      const g = byHash.get(h) || [];
      g.push(f.path);
      byHash.set(h, g);
    }
    for (const [h, paths] of byHash) {
      if (paths.length < 2) continue;
      wasted += size * (paths.length - 1);
      groups.push({ size: humanBytes(size), size_bytes: size, sha256: h.slice(0, 16), count: paths.length, files: paths });
    }
  }
  groups.sort((a, b) => b.size_bytes * (b.count - 1) - a.size_bytes * (a.count - 1));
  return {
    dir: dir_path,
    scanned_files: files.length,
    hashed_files: hashed,
    hash_errors: hashErrors,
    truncated,
    duplicate_groups: groups.length,
    wasted: humanBytes(wasted),
    wasted_bytes: wasted,
    groups: groups.slice(0, 30),
  };
}

/* ============================ 4c. EXIF 读取（v1.3 新增） ============================ */

const EXIF_TAG_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const IFD0_TAGS = { 0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0131: 'software', 0x0132: 'datetime' };
const EXIF_IFD_TAGS = {
  0x9003: 'datetime_original', 0x9004: 'datetime_digitized', 0x829a: 'exposure_time',
  0x829d: 'f_number', 0x8827: 'iso', 0x920a: 'focal_length', 0x9209: 'flash',
  0xa002: 'pixel_width', 0xa003: 'pixel_height', 0x0112: 'orientation',
};
const GPS_TAGS = { 0x0001: 'lat_ref', 0x0002: 'lat', 0x0003: 'lon_ref', 0x0004: 'lon', 0x0006: 'altitude' };

/** 从 JPEG 头部字节里定位 APP1 Exif 段 */
function findExifSegment(head) {
  let p = 2;
  while (p + 4 <= head.length) {
    if (head[p] !== 0xff) { p++; continue; }
    const marker = head[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return null; // 进入图像数据/结束
    const len = head.readUInt16BE(p + 2);
    if (len < 2) return null;
    if (marker === 0xe1 && head.toString('latin1', p + 4, p + 8) === 'Exif') {
      return { start: p + 4 + 6, end: p + 2 + len }; // 跳过 "Exif\0\0"
    }
    p += 2 + len;
  }
  return null;
}

function parseExifTiff(buf, base) {
  const order = buf.toString('latin1', base, base + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const rd16 = (o) => (order === 'II' ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const rd32 = (o) => (order === 'II' ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (rd16(base + 2) !== 42) return null;
  const ifd0Off = rd32(base + 4);

  const readIfd = (off) => {
    const map = new Map();
    if (base + off + 2 > buf.length) return map;
    const n = rd16(base + off);
    for (let i = 0; i < n; i++) {
      const e = base + off + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = rd16(e);
      const type = rd16(e + 2);
      const count = rd32(e + 4);
      const unit = EXIF_TAG_SIZE[type];
      if (!unit) continue;
      const size = unit * count;
      const valueOff = size <= 4 ? e + 8 : base + rd32(e + 8);
      if (valueOff + size > buf.length) continue;
      let value;
      if (type === 2) {
        value = buf.toString('latin1', valueOff, valueOff + size).replace(/\0+$/, '');
      } else if (type === 5 || type === 10) {
        const arr = [];
        for (let k = 0; k < count; k++) {
          const o = valueOff + k * 8;
          const num = order === 'II' ? (type === 5 ? buf.readUInt32LE(o) : buf.readInt32LE(o)) : (type === 5 ? buf.readUInt32BE(o) : buf.readInt32BE(o));
          const den = order === 'II' ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o + 4);
          arr.push(den === 0 ? 0 : num / den);
        }
        value = count === 1 ? arr[0] : arr;
      } else if (count === 1) {
        value = type === 1 || type === 7 ? buf[valueOff] : type === 3 ? rd16(valueOff) : rd32(valueOff);
      } else {
        const arr = [];
        for (let k = 0; k < count; k++) {
          arr.push(type === 3 ? rd16(valueOff + k * 2) : type === 4 ? rd32(valueOff + k * 4) : buf[valueOff + k]);
        }
        value = arr;
      }
      map.set(tag, value);
    }
    return map;
  };

  const ifd0 = readIfd(ifd0Off);
  const out = {};
  for (const [tag, key] of Object.entries(IFD0_TAGS)) if (ifd0.has(Number(tag))) out[key] = ifd0.get(Number(tag));
  const exifPtr = ifd0.get(0x8769);
  const gpsPtr = ifd0.get(0x8825);
  if (typeof exifPtr === 'number') {
    const ex = readIfd(exifPtr);
    for (const [tag, key] of Object.entries(EXIF_IFD_TAGS)) if (ex.has(Number(tag)) && out[key] === undefined) out[key] = ex.get(Number(tag));
  }
  if (typeof gpsPtr === 'number') {
    const gp = readIfd(gpsPtr);
    const lat = gp.get(0x0002);
    const lon = gp.get(0x0004);
    const dms = (v) => (Array.isArray(v) && v.length === 3 ? v[0] + v[1] / 60 + v[2] / 3600 : undefined);
    const la = dms(lat);
    const lo = dms(lon);
    if (la !== undefined && lo !== undefined) {
      out.gps = {
        lat: Number((gp.get(0x0001) === 'S' ? -la : la).toFixed(6)),
        lon: Number((gp.get(0x0003) === 'W' ? -lo : lo).toFixed(6)),
        altitude_m: typeof gp.get(0x0006) === 'number' ? Number(gp.get(0x0006).toFixed(1)) : undefined,
      };
    }
  }
  return out;
}

/** "2026:11:02 08:51:57" -> "2026-11-02T08:51:57" */
function exifTime(v) {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : v;
}

function readExifOfFile(p) {
  const st = fs.statSync(p);
  const fd = fs.openSync(p, 'r');
  try {
    const head = readFull(fd, 0, Math.min(st.size, 1 << 20));
    const seg = findExifSegment(head);
    const base = { path: p, size_bytes: st.size, file_mtime: new Date(st.mtimeMs).toISOString().slice(0, 19) };
    if (!seg) return { ...base, has_exif: false, reason: '没有 Exif APP1 段（可能被导出工具剥离）' };
    const tiff = head.subarray(seg.start, seg.end);
    const parsed = parseExifTiff(tiff, 0);
    if (!parsed) return { ...base, has_exif: false, reason: 'Exif 段解析失败（字节序/魔数异常）' };
    const taken = exifTime(parsed.datetime_original || parsed.datetime_digitized || parsed.datetime);
    const out = {
      ...base,
      has_exif: true,
      taken_at: taken,
      time_source: taken ? 'exif' : 'mtime（无拍摄时间字段）',
    };
    if (parsed.make || parsed.model) out.camera = { make: parsed.make, model: parsed.model };
    if (parsed.software) out.software = parsed.software;
    if (parsed.orientation !== undefined) out.orientation = parsed.orientation;
    if (parsed.pixel_width || parsed.pixel_height) out.dimensions = { pixel_width: parsed.pixel_width, pixel_height: parsed.pixel_height };
    const exposure = {};
    if (parsed.f_number !== undefined) exposure.f_number = Number(Number(parsed.f_number).toFixed(2));
    if (parsed.exposure_time !== undefined) {
      const t = Number(parsed.exposure_time);
      exposure.exposure_time = t > 0 && t < 1 ? '1/' + Math.round(1 / t) : String(Number(t.toFixed(3)));
    }
    if (parsed.iso !== undefined) exposure.iso = parsed.iso;
    if (parsed.focal_length !== undefined) exposure.focal_length_mm = Number(Number(parsed.focal_length).toFixed(1));
    if (Object.keys(exposure).length) out.exposure = exposure;
    if (parsed.gps) out.gps = parsed.gps;
    // mtime 与 Exif 差多少，提示「文件时间不可信」
    if (taken) {
      const dt = Math.abs(new Date(taken).getTime() - st.mtimeMs);
      out.mtime_vs_taken = dt > 86400000 ? '相差 ' + Math.round(dt / 86400000) + ' 天，优先信 Exif' : '一致（<1 天）';
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

const IMAGE_EXT = /\.(jpe?g|heic|heif|tiff?)$/i;

function toolReadExif({ file_path, limit = 50 }) {
  if (!file_path || typeof file_path !== 'string') throw new Error('缺少参数 file_path');
  const st = fs.statSync(file_path);
  if (st.isFile()) return readExifOfFile(file_path);
  if (!st.isDirectory()) throw new Error('既不是文件也不是目录: ' + file_path);
  const { files } = walkFiles(file_path, { recursive: false, maxEntries: 2000 });
  const imgs = files.filter((f) => IMAGE_EXT.test(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const picked = imgs.slice(0, cap);
  const rows = [];
  const models = {};
  let withExif = 0;
  let withGps = 0;
  const times = [];
  for (const f of picked) {
    try {
      const r = readExifOfFile(f.path);
      if (r.has_exif) withExif++;
      if (r.gps) withGps++;
      if (r.camera && r.camera.model) models[r.camera.model] = (models[r.camera.model] || 0) + 1;
      if (r.taken_at) times.push(r.taken_at);
      rows.push({
        name: f.name,
        size: humanBytes(f.size),
        taken_at: r.taken_at || null,
        camera: r.camera ? r.camera.model || r.camera.make : null,
        gps: r.gps ? r.gps.lat + ',' + r.gps.lon : null,
        has_exif: r.has_exif,
        note: r.has_exif ? undefined : r.reason,
      });
    } catch (e) {
      rows.push({ name: f.name, error: e.message.slice(0, 80) });
    }
  }
  times.sort();
  return {
    dir: file_path,
    images_found: imgs.length,
    checked: picked.length,
    with_exif: withExif,
    with_gps: withGps,
    models,
    taken_range: times.length ? { from: times[0], to: times[times.length - 1] } : null,
    items: rows,
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
  {
    name: 'probe_dir',
    title: '目录媒体体检',
    description:
      '批量体检一个目录：逐个文件的类型（魔数嗅探）、大小、修改时间，视频给出时长/分辨率/编码，图片给出尺寸，并按图片/视频/音频/文档/压缩包汇总占用。比逐个调 get_video_info 省往返。',
    inputSchema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: '目录绝对路径，例如 /sdcard/DCIM/Camera' },
        limit: { type: 'number', description: '最多返回前几个文件，默认 20，上限 60' },
        sort: { type: 'string', enum: ['mtime', 'size'], description: '排序依据：mtime（默认，最新在前）或 size（最大在前）' },
        recursive: { type: 'boolean', description: '是否递归子目录，默认 false' },
      },
      required: ['dir_path'],
    },
    handler: toolProbeDir,
  },
  {
    name: 'storage_report',
    title: '空间占用分析',
    description:
      '分析一个目录的空间都去哪了：Top 子目录、按文件类型（图片/视频/音频/文档/压缩包）的占用分布、最大的几个文件。用于「手机空间不够了帮我看看」。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要分析的目录绝对路径' },
        top: { type: 'number', description: '列出前几个子目录，默认 8' },
        max_entries: { type: 'number', description: '最多扫描多少个文件，默认 20000' },
      },
      required: ['path'],
    },
    handler: toolStorageReport,
  },
  {
    name: 'find_duplicates',
    title: '重复文件查找',
    description:
      '找出目录里的重复文件：先按文件大小分组，只对同尺寸的候选算 sha256 确认，返回重复组、可回收空间。适合清理相册里重复保存的图片。只读，不删除。',
    inputSchema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: '目录绝对路径' },
        min_bytes: { type: 'number', description: '只检查不小于该字节数的文件，默认 102400（100 KiB）' },
        max_files: { type: 'number', description: '最多扫描多少个文件，默认 3000' },
      },
      required: ['dir_path'],
    },
    handler: toolFindDuplicates,
  },
  {
    name: 'read_exif',
    title: '照片 EXIF（拍摄时间/GPS/机型）',
    description:
      '读取 JPEG 的 EXIF：拍摄时间（DateTimeOriginal）、机型、GPS 经纬度、光圈/快门/ISO/焦距、像素尺寸，并对比文件修改时间提示「文件时间是否可信」。传目录则批量汇总（有 EXIF 几张、时间跨度、机型分布）。用于按真实拍摄时间整理相册。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '图片文件或目录的绝对路径' },
        limit: { type: 'number', description: '目录模式下最多检查几张，默认 50，上限 200' },
      },
      required: ['file_path'],
    },
    handler: toolReadExif,
  },
];

/* ============================ 5. JSON-RPC / stdio 传输层 ============================ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
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
          '本服务运行在一台 Android 手机上（无 Python、无 ffmpeg），提供 7 个工具：媒体元数据探测(get_video_info)、AAC 音轨直抽(extract_audio_track)、目录媒体体检(probe_dir)、空间占用分析(storage_report)、重复文件查找(find_duplicates)、照片 EXIF 读取(read_exif，支持目录批量)、硬件快照(get_system_hardware)。全部只读或只新增输出文件，不会修改或删除源文件。媒体解析为纯 JS 实现。',
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
