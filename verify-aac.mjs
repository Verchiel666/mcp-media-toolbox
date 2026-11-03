import fs from 'node:fs';
const b = fs.readFileSync(process.argv[2]);
const sync = b[0] === 0xff && (b[1] & 0xf0) === 0xf0;
let off = 0, frames = 0, bad = 0, minLen = 1e9, maxLen = 0;
while (off + 7 <= b.length) {
  if (b[off] !== 0xff || (b[off + 1] & 0xf0) !== 0xf0) { bad++; break; }
  const len = ((b[off + 3] & 3) << 11) | (b[off + 4] << 3) | ((b[off + 5] >> 5) & 7);
  if (len < 7 || off + len > b.length) { bad++; break; }
  minLen = Math.min(minLen, len); maxLen = Math.max(maxLen, len);
  off += len; frames++;
}
console.log(`文件前 16 字节 : ${b.subarray(0, 16).toString('hex')}`);
console.log(`同步字 0xFFF   : ${sync ? 'OK' : 'BAD'}`);
console.log(`ADTS 固定头    : profile=${(b[2] >> 6) & 3} sfIndex=${(b[2] >> 2) & 0xf} channels=${((b[2] & 1) << 2) | ((b[3] >> 6) & 3)} 首帧长=${((b[3] & 3) << 11) | (b[4] << 3) | ((b[5] >> 5) & 7)}B`);
console.log(`逐帧遍历       : frames=${frames}, 覆盖 ${off}/${b.length} 字节 (${((off / b.length) * 100).toFixed(2)}%), 异常=${bad}`);
console.log(`帧长范围       : ${minLen} ~ ${maxLen} 字节`);
console.log(`推算时长       : ${((frames * 1024) / 48000).toFixed(2)} 秒 (1024 samples/帧 @48kHz)`);
