#!/usr/bin/env node
/**
 * 应用示例：把手机相册/目录批量喂给 MCP Server 的 get_video_info，
 * 输出一张媒体指纹表。这演示了「Agent 不需要知道 FFmpeg 怎么用，
 * 只要知道有个叫 get_video_info 的工具」这件事。
 *   用法: node batch-probe.mjs /sdcard/DCIM/Camera 6
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '/sdcard/DCIM/Camera';
const limit = Number(process.argv[3] || 6);
const serverPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'server.mjs');

const files = fs.readdirSync(dir)
  .map((f) => ({ f, st: fs.statSync(path.join(dir, f)) }))
  .filter((x) => x.st.isFile())
  .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  .slice(0, limit);

const proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.resume();
const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
const pending = new Map();
let seq = 0;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const rpc = (method, params) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'batch-probe', version: '1.0.0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log('目录: ' + dir + '   取最近 ' + files.length + ' 个文件\n');
console.log('文件'.padEnd(30) + '大小'.padStart(10) + '  类型      尺寸/时长');
console.log('-'.repeat(78));
let total = 0;
for (const { f, st } of files) {
  const r = await rpc('tools/call', { name: 'get_video_info', arguments: { file_path: path.join(dir, f) } });
  const t = r.result?.content?.[0]?.text;
  if (!t) { console.log(f.padEnd(30) + '  (调用失败)'); continue; }
  const d = JSON.parse(t);
  total += st.size;
  const kind = d.sniffed?.kind || '?';
  const dim = d.sniffed?.width ? d.sniffed.width + 'x' + d.sniffed.height : d.duration_sec ? d.duration_sec + 's ' + (d.video?.[0]?.width || '?') + 'x' + (d.video?.[0]?.height || '?') : '-';
  console.log(f.slice(0, 29).padEnd(30) + (st.size / 1048576).toFixed(2).padStart(9) + 'M  ' + kind.padEnd(10) + dim);
}
console.log('-'.repeat(78));
console.log('合计 ' + (total / 1048576).toFixed(2) + ' MiB，全部经由 MCP tools/call 获取');
proc.stdin.end();
