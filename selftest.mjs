#!/usr/bin/env node
/**
 * 自检套件：恢复之后跑这一条，就知道整包还能不能用。
 *   node selftest.mjs            正常跑完打印 PASS/FAIL 表
 *   node selftest.mjs --verbose  额外打印每次调用的耗时
 * 退出码 0 = 全部通过。
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');
const TMP = path.join(HERE, '.selftest');

const proc = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderrBuf = '';
proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
const pending = new Map();
let seq = 0;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++seq; const t0 = process.hrtime.bigint();
  pending.set(id, (m) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (VERBOSE) process.stdout.write(`      (${method}${params?.name ? ' ' + params.name : ''} ${ms.toFixed(1)}ms)\n`);
    res(m);
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('超时: ' + method)); } }, 30000);
});
const call = async (name, args) => {
  const m = await rpc('tools/call', { name, arguments: args });
  if (m.error) throw new Error('协议错误 ' + m.error.code + ': ' + m.error.message);
  const text = m.result.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { isError: m.result.isError === true, data };
};

let pass = 0; let fail = 0; const failures = [];
const check = (name, fn) => {
  try {
    const r = fn();
    if (r === false) throw new Error('断言为 false');
    pass++; console.log('  ✓ ' + name);
  } catch (e) {
    fail++; failures.push(name + ' -> ' + e.message);
    console.log('  ✗ ' + name + '  ' + e.message);
  }
};

try {
  // ── 1. 生命周期 ────────────────────────────────────────────────
  console.log('\n[1] 协议握手');
  const init = await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'selftest', version: '1.0.0' },
  });
  check('initialize 返回 serverInfo', () => {
    if (init.result?.serverInfo?.name !== 'node7-media-toolbox') throw new Error(JSON.stringify(init.result));
  });
  check('协议版本在支持列表内', () => {
    const v = init.result.protocolVersion;
    if (!['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(v)) throw new Error(v);
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // ── 2. 工具清单 ────────────────────────────────────────────────
  console.log('\n[2] 工具清单');
  const list = await rpc('tools/list');
  const names = list.result.tools.map((t) => t.name).sort();
  const EXPECT = ['extract_audio_track', 'find_duplicates', 'get_system_hardware', 'get_video_info', 'probe_dir', 'read_exif', 'storage_report'];
  check('7 个工具齐全', () => {
    const missing = EXPECT.filter((n) => !names.includes(n));
    if (missing.length) throw new Error('缺 ' + missing.join(','));
  });
  check('每个工具都有 inputSchema', () => {
    const bad = list.result.tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
    if (bad.length) throw new Error(bad.map((t) => t.name).join(','));
  });

  // ── 3. 媒体探测 ────────────────────────────────────────────────
  console.log('\n[3] 媒体探测');
  const a3 = path.join(HERE, 'fixtures/sample.mp4');
  const r3 = await call('get_video_info', { file_path: a3 });
  check('sample.mp4 时长 13.347s', () => {
    if (r3.isError) throw new Error(r3.data.raw || 'isError');
    if (Math.abs(r3.data.duration_sec - 13.347) > 0.01) throw new Error('实测 ' + r3.data.duration_sec);
  });
  check('sample.mp4 视频流 640x360 avc1 30fps', () => {
    const v = r3.data.video?.[0];
    if (!v || v.width !== 640 || v.height !== 360 || v.codec !== 'avc1' || v.fps !== 30) throw new Error(JSON.stringify(v));
  });
  check('sample.mp4 音频流 mp4a 48kHz 2ch', () => {
    const a = r3.data.audio?.[0];
    if (!a || a.codec !== 'mp4a' || a.sample_rate !== 48000 || a.channels !== 2) throw new Error(JSON.stringify(a));
  });
  check('视频/音频两轨都被识别', () => {
    if ((r3.data.video || []).length !== 1 || (r3.data.audio || []).length !== 1) {
      throw new Error('轨数不对 video=' + (r3.data.video || []).length + ' audio=' + (r3.data.audio || []).length);
    }
  });

  // ── 4. 音轨直抽 + ADTS 自校验 ─────────────────────────────────
  console.log('\n[4] 音轨直抽');
  fs.mkdirSync(TMP, { recursive: true });
  const outAac = path.join(TMP, 'out.aac');
  const r4 = await call('extract_audio_track', { input_path: a3, output_path: outAac });
  check('抽出 626 帧', () => {
    if (r4.isError) throw new Error(r4.data.raw || 'isError');
    if (r4.data.frames !== 626) throw new Error('实测 ' + r4.data.frames);
  });
  check('产物 ADTS 逐帧自洽且覆盖率 100%', () => {
    const b = fs.readFileSync(outAac);
    let off = 0, frames = 0;
    while (off + 7 <= b.length) {
      if (b[off] !== 0xff || (b[off + 1] & 0xf0) !== 0xf0) throw new Error('第 ' + frames + ' 帧同步字坏');
      const len = ((b[off + 3] & 3) << 11) | (b[off + 4] << 3) | ((b[off + 5] >> 5) & 7);
      if (len < 7 || off + len > b.length) throw new Error('第 ' + frames + ' 帧长度越界');
      off += len; frames++;
    }
    if (off !== b.length) throw new Error('未覆盖全部字节');
    if (frames !== 626) throw new Error('帧数 ' + frames);
  });

  // ── 5. EXIF ───────────────────────────────────────────────────
  console.log('\n[5] EXIF');
  const r5 = await call('read_exif', { file_path: path.join(HERE, 'fixtures/synthetic-exif.jpg') });
  check('合成样张机型 COOLPIX P6000', () => {
    if (r5.isError) throw new Error(r5.data.raw || 'isError');
    if (r5.data.camera?.model !== 'COOLPIX P6000') throw new Error(JSON.stringify(r5.data.camera));
  });
  check('合成样张拍摄时间 2008-10-22', () => {
    if (!String(r5.data.taken_at).startsWith('2008-10-22')) throw new Error(String(r5.data.taken_at));
  });
  check('合成样张 GPS 43.474392 / 11.883363', () => {
    const g = r5.data.gps;
    if (!g || Math.abs(g.lat - 43.474392) > 1e-5 || Math.abs(g.lon - 11.883363) > 1e-5) throw new Error(JSON.stringify(g));
  });

  // ── 6. 目录级工具 ─────────────────────────────────────────────
  console.log('\n[6] 目录级工具');
  const r6 = await call('probe_dir', { dir_path: path.join(HERE, 'fixtures'), limit: 5 });
  check('probe_dir 扫到文件且分类非空', () => {
    if (r6.isError) throw new Error(r6.data.raw || 'isError');
    if (!(r6.data.files_count > 0)) throw new Error('files_count=' + r6.data.files_count);
    if (!r6.data.by_category || !Object.keys(r6.data.by_category).length) throw new Error('无分类');
  });
  const r7 = await call('storage_report', { path: path.join(HERE, 'fixtures'), top: 3 });
  check('storage_report 总量 > 0', () => {
    if (!(r7.data.total_bytes > 0)) throw new Error('total_bytes=' + r7.data.total_bytes);
  });
  const dupDir = path.join(TMP, 'dup');
  fs.mkdirSync(dupDir, { recursive: true });
  const src = fs.readFileSync(path.join(HERE, 'fixtures/synthetic-exif.jpg'));
  fs.writeFileSync(path.join(dupDir, 'a.jpg'), src);
  fs.writeFileSync(path.join(dupDir, 'b.jpg'), src);
  fs.writeFileSync(path.join(dupDir, 'c.jpg'), Buffer.concat([src, Buffer.from('different')]));
  const r8 = await call('find_duplicates', { dir_path: dupDir, min_bytes: 1 });
  check('find_duplicates 找到 1 组重复', () => {
    if (r8.isError) throw new Error(r8.data.raw || 'isError');
    if (r8.data.duplicate_groups !== 1) throw new Error('实测 ' + r8.data.duplicate_groups);
    if (r8.data.hash_errors !== 0) throw new Error('哈希错误 ' + r8.data.hash_errors);
  });

  // ── 7. 硬件快照 ───────────────────────────────────────────────
  console.log('\n[7] 硬件快照');
  const r9 = await call('get_system_hardware', {});
  check('返回 arch 与 node 版本', () => {
    if (!r9.data.arch || !r9.data.runtime?.node) throw new Error(JSON.stringify(r9.data).slice(0, 120));
  });

  // ── 8. 错误路径 ───────────────────────────────────────────────
  console.log('\n[8] 错误路径（必须优雅失败）');
  const e1 = await call('get_video_info', { file_path: '/nonexistent/x.mp4' });
  check('不存在的文件 -> isError=true 且带原因', () => {
    if (!e1.isError) throw new Error('居然没报错');
    if (!/ENOENT|不存在/.test(e1.data.raw || '')) throw new Error('原因不明确: ' + e1.data.raw);
  });
  const e2 = await call('get_video_info', {});
  check('缺参数 -> isError=true', () => { if (!e2.isError) throw new Error('居然没报错'); });
  let e3 = null;
  try { await call('no_such_tool', {}); } catch (err) { e3 = err.message; }
  check('未知工具 -> 协议错误 -32602', () => { if (!/-32602/.test(String(e3))) throw new Error(String(e3)); });

  // ── 9. stdout 洁净 = 全程没出现过「客户端解析失败」────────────────
  check('stdout 全程为合法 JSON（无污染）', () => { if (/Parse error|非法 JSON/.test(stderrBuf)) throw new Error('server 报过污染'); });
} catch (e) {
  fail++; failures.push('套件中断 -> ' + e.message);
  console.log('\n!! 套件中断: ' + e.message);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  proc.stdin.end();
}

console.log(`\n${'='.repeat(46)}`);
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(46));
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 100);
