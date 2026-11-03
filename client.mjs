#!/usr/bin/env node
/**
 * 手写 MCP 客户端（零依赖）：spawn 一个 stdio MCP Server，跑完整生命周期。
 *
 *   node client.mjs --demo                 # 走完整流程：initialize -> tools/list -> 逐个调用
 *   node client.mjs --list                 # 只列工具
 *   node client.mjs --call get_video_info '{"file_path":"/sdcard/a.mp4"}'
 *   node client.mjs --server <path> ...    # 指定 server 脚本
 *
 * 输出带 [C->S] / [S->C] 前缀，方便肉眼核对协议帧。
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);
const SERVER = opt('--server', path.join(HERE, 'server.mjs'));
const QUIET = flag('--quiet');

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(3) + 's';
const out = (...a) => console.log(...a);

class McpClient {
  constructor(serverPath) {
    this.seq = 0;
    this.pending = new Map();
    this.proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) out('\x1b[90m  [server:stderr] ' + line.trimEnd() + '\x1b[0m');
      }
    });
    this.rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      if (!QUIET) out('\x1b[36m[S->C]\x1b[0m ' + truncate(line));
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        out('!! 客户端 JSON 解析失败（说明 stdout 被污染了）: ' + line);
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message + ' (code ' + msg.error.code + ')')) : resolve(msg.result);
      }
    });
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error('server 退出，code=' + code));
      this.pending.clear();
    });
  }

  send(method, params) {
    const id = ++this.seq;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    const line = JSON.stringify(msg);
    if (!QUIET) out('\x1b[33m[C->S]\x1b[0m ' + truncate(line));
    this.proc.stdin.write(line + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('请求超时: ' + method));
        }
      }, 20000);
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    const line = JSON.stringify(msg);
    if (!QUIET) out('\x1b[33m[C->S]\x1b[0m ' + truncate(line));
    this.proc.stdin.write(line + '\n');
  }

  close() {
    try { this.proc.stdin.end(); } catch {}
  }
}

function truncate(s, n = 260) {
  return s.length > n ? s.slice(0, n) + ' …(' + s.length + ' bytes)' : s;
}

function hr(t) {
  out('\n\x1b[1m──── ' + t + ' ────\x1b[0m');
}

const client = new McpClient(SERVER);

async function main() {
  const mode = flag('--list') ? 'list' : flag('--call') ? 'call' : 'demo';

  hr('1. initialize 握手（协议版本 + 能力协商）');
  const init = await client.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: 'dsh-handwritten-client', title: '手写 MCP 客户端', version: '1.0.0' },
  });
  out('  -> 协商结果: ' + init.protocolVersion + ' | serverInfo=' + JSON.stringify(init.serverInfo));
  client.notify('notifications/initialized');
  await new Promise((r) => setTimeout(r, 60));

  if (mode === 'call') {
    const name = opt('--call');
    const args = JSON.parse(opt('--args', '{}'));
    const res = await client.send('tools/call', { name, arguments: args });
    if (flag('--text')) {
      const t = (res.content || []).map((x) => x.text).join('\n');
      out(res.isError ? '[isError] ' + t : t);
    } else out(JSON.stringify(res, null, 2));
    client.close();
    return;
  }

  hr('2. tools/list 拉取工具清单');
  const list = await client.send('tools/list', {});
  for (const t of list.tools) {
    const req = (t.inputSchema.required || []).join(', ') || '无';
    out('  • ' + t.name + '  (' + t.title + ')  必填: ' + req);
  }
  if (mode === 'list') { client.close(); return; }

  hr('3. tools/call —— 逐个打真实数据');
  const cases = JSON.parse(opt('--cases', 'null')) || [
    { name: 'get_system_hardware', arguments: {} },
    { name: 'get_video_info', arguments: { file_path: path.join(HERE, 'samples/test.mp4') } },
    { name: 'get_video_info', arguments: { file_path: path.join(HERE, 'samples/a3.mp4') } },
    { name: 'extract_audio_track', arguments: { input_path: path.join(HERE, 'samples/a3.mp4'), output_path: path.join(HERE, 'samples/demo.aac') } },
    { name: 'get_video_info', arguments: { file_path: OUT_JPG } },
  ];
  for (const c of cases) {
    out('\n  → 调用 ' + c.name + ' ' + JSON.stringify(c.arguments));
    const res = await client.send('tools/call', c);
    const text = (res.content || []).map((x) => x.text).join('\n');
    out(text.split('\n').map((l) => '    ' + l).join('\n'));
    if (res.isError) out('    !! isError=true');
  }

  hr('4. 负路径测试（错误参数 / 未知工具）');
  for (const bad of [
    { name: 'get_video_info', arguments: { file_path: '/sdcard/不存在的文件.mp4' } },
    { name: 'get_video_info', arguments: {} },
    { name: 'no_such_tool', arguments: {} },
  ]) {
    try {
      const res = await client.send('tools/call', bad);
      out('  ' + bad.name + ' -> isError=' + res.isError + ' | ' + (res.content?.[0]?.text || '').slice(0, 100));
    } catch (e) {
      out('  ' + bad.name + ' -> 协议级错误: ' + e.message);
    }
  }

  hr('完成');
  out('  客户端总耗时 ' + stamp() + '，最大并发数 1（stdio 单管道）');
  client.close();
  setTimeout(() => process.exit(0), 50);
}

const OUT_JPG = opt('--jpg', '/sdcard/DCIM/Camera/mmexport1793580362848.jpg');

main().catch((e) => {
  console.error('客户端异常: ' + e.stack);
  client.close();
  process.exit(1);
});
