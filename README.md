# mcp-media-toolbox

**一个零依赖的 MCP 服务器：媒体元数据探测 / AAC 音轨直抽 / EXIF 读取。不需要 ffmpeg，不需要 Python。**

> A zero-dependency MCP server for media probing, AAC extraction and EXIF — no ffmpeg, no Python.
> Runs where you cannot install binaries: Android app sandboxes, Termux, minimal containers.

整个 server 只 import 4 个 Node 内置模块（`fs` / `os` / `crypto` / `readline`），
`npm install` 什么都不装，`node server.mjs` 直接跑。

## 为什么会有这个

主流媒体工具都依赖 `ffmpeg`/`ffprobe`。但在**受限环境**里（Android 应用私有目录禁止执行二进制、
无 root、无 Python、容器里不想装 100 MB 依赖），这条路直接断掉。

这个项目把最常用的三件事用纯 JS 重写：

| 能力 | 怎么做的 |
|---|---|
| MP4/MOV 元数据 | 手工解析 ISO-BMFF：`ftyp/moov/mvhd/tkhd/mdhd/stsd/stts/stsz/stco/stsc` |
| AAC 音轨 → `.aac` | 按 `stco/stsc/stsz` 定位样本，解析 `esds` 的 AudioSpecificConfig，**手工打 ADTS 头** |
| EXIF | 解析 JPEG APP1 的 TIFF/IFD（IFD0 / ExifIFD / GPS IFD，支持 II/MM 字节序） |

## 快速开始

```bash
git clone https://github.com/Verchiel666/mcp-media-toolbox.git && cd mcp-media-toolbox
npm run fixtures      # 生成合成测试素材（仓库里没有第三方二进制）
npm run selftest      # 21 项断言，退出码 0 = 全过
node client.mjs --demo
```

接进任何 MCP 客户端（Claude Desktop / Cursor / 自研）：

```json
{
  "mcpServers": {
    "media-toolbox": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    }
  }
}
```

已发布到 npm，可以直接用 npx（无需 clone）：

```json
{
  "mcpServers": {
    "media-toolbox": {
      "command": "npx",
      "args": ["-y", "mcp-media-toolbox"]
    }
  }
}
```

```bash
npx -y mcp-media-toolbox   # 直接作为 stdio server 启动
```

## 工具

| 工具 | 说明 |
|---|---|
| `get_video_info` | 容器/时长/总码率；每轨编码、分辨率、帧率、码率、声道、采样率、AAC 参数；图片给尺寸；其他文件给魔数嗅探 |
| `extract_audio_track` | mp4/m4a 的 AAC 轨直抽为 ADTS `.aac` 裸流 |
| `probe_dir` | 目录批量体检 + 按类型汇总占用 |
| `storage_report` | Top 子目录 / 类型分布 / 最大文件 |
| `find_duplicates` | 大小预筛 + sha256 确认的重复文件组 |
| `read_exif` | 拍摄时间、机型、GPS、光圈快门 ISO 焦距；并对比文件 mtime 提示「该信哪一个」 |
| `get_system_hardware` | 架构 / 内存 / 磁盘 / Node 版本 |

全部只读，或只新增输出文件，不修改、不删除源文件。

## 实测数据

在 Android 15（arm64，Node v24.22.1，无 ffmpeg）上：

| 项目 | 结果 |
|---|---|
| 4.17 MiB mp4（854×480 avc1 24fps + mp4a AAC-LC 48k 2ch） | `get_video_info` 4.4 ms |
| 同一文件的 AAC 直抽 | 2435 帧 / 839716 字节，42.6 ms |
| 产物校验 | 逐帧遍历 ADTS：覆盖率 100%、0 异常、推算时长 51.95 s 与源轨道 51.947 s 一致 |
| 5712×4284 手机照片 | 3.7 ms |

`selftest.mjs` 用合成素材跑同样的断言，所以 CI 不需要任何外部文件。

## 已知限制（诚实清单）

- 只解析**带 `moov`** 的 ISO-BMFF；碎片化 mp4 / fMP4 / MKV / 裸流一律明确报错，不假装成功。
- 只直抽 **AAC（`mp4a`）**；Opus / AC-3 / ALAC 不支持。不做重采样、不转 WAV。
- HE-AAC（SBR/PS）会被当成 AAC-LC 写 ADTS 头：能播，但采样率标注可能偏低。
- EXIF 仅 JPEG；PNG/HEIC 未实现。
- `find_duplicates` 对超大目录只做有界扫描（默认 3000 文件），返回里有 `truncated` 标记。

## 三个必踩的坑（`experiments/` 可复现）

写 MCP server 时最容易在这三处翻车，详见 [docs/mcp-notes.md](docs/mcp-notes.md)：

1. 工具里一句 `console.log` 污染 stdout → 客户端 JSON 解析当场崩。
2. **美化输出**（`JSON.stringify(x, null, 2)`）把一个消息拆成多行，同样违规，而且症状只是「没反应」。
3. 握手顺序错（缺 `notifications/initialized`）→ 客户端无限转圈。

```bash
node client.mjs --list --server experiments/server-pretty.mjs   # 看它怎么炸
```

## 在 DSH（Android）里挂本地 server

DSH 引擎自带 `@deepseek-ai/dsh-mcp-client`，但 App 的设置页只接受远程 HTTP / npm 包，
**拒绝本地 `node script.mjs` 这种写法**。可行方式与踩坑记录见 [docs/dsh-android.md](docs/dsh-android.md)。

## 在 npm 上

[`mcp-media-toolbox`](https://www.npmjs.com/package/mcp-media-toolbox) —— 只发布 `server.mjs` 与文档，测试素材不进包（21.6 KiB）。

## 相关

同源的姊妹项目：[DSH](https://deepseek-harness.github.io/deepseek-harness/)（本项目的 MCP 桥接就是在它上面验证的）。

## License

MIT
