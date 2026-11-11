# 流水线说明

三个脚本，一条链：**出图 → 批量 → 合成**。另外两个小工具用来"看图"。

```
frames.json ──> batch_frames.mjs ──> gen_image.mjs ──> assets/keyframes/*.png
                                                              │
plan.json ────────────────────────────────────────────────────┴──> build.mjs ──> video/*.mp4
```

## 依赖

- Node.js 18+（用到内置 `fetch` / `FormData` / `Blob`）
- ffmpeg / ffprobe 在 `PATH` 中
- 一个 OpenAI 兼容的生图接口

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `IMG_BASE` | 生图接口地址，如 `https://host/v1` | 必填 |
| `IMG_API_KEY` | 密钥 | 必填 |
| `IMG_MODEL` | 默认模型 | `gpt-image-2` |

## 脚本

### `gen_image.mjs` — 单张出图

```bash
node pipeline/tools/gen_image.mjs \
  --prompt "一只卡通恶魔握着超长筷子" \
  --out assets/keyframes/demo.png \
  --size 1536x1024 \
  --ref assets/anchors/恶魔.jpg      # 可选，可重复传多张
```

无 `--ref` 走 `/images/generations`，有 `--ref` 走 `/images/edits`（multipart）。失败自动重试 3 次。

### `batch_frames.mjs` — 按清单批量出图

```bash
node pipeline/tools/batch_frames.mjs                 # 全部缺失的
node pipeline/tools/batch_frames.mjs 10a_heaven_full # 指定 id
```

读取 `pipeline/frames.json`：`{ id, size, ref, prompt }`。已存在的文件会跳过，想重做就删掉再跑。

### `build.mjs` — 合成成片

```bash
node pipeline/tools/build.mjs --dry-run   # 只看时间轴与素材解析
node pipeline/tools/build.mjs             # 增量构建
FORCE=1 node pipeline/tools/build.mjs     # 强制重渲所有片段
REMUX_ONLY=1 node pipeline/tools/build.mjs # 只换音轨，不重编码画面
```

它做五件事：

1. **派生分屏图**：`01b + 02b` → `video/.build/split_composite.png`（缓存，不重复生成）
2. **逐镜渲染**：按 `plan.json` 的 `beats` 生成片段，支持 `still`（带运镜）/ `static`（完全静止）
3. **拼接**：`concat` demuxer 无损拼接
4. **字幕**：生成 ASS（四种样式：Narr / Lead / Lead2 / Title），叠加底部渐变压暗后烧录
5. **配乐 + 封装**：三段式合成音轨，混流输出 `video/heaven-hell-chopsticks-<片长>s.mp4`

## `plan.json` 结构

```jsonc
{
  "fps": 30, "width": 1920, "height": 1080, "crf": 18,
  "narr":  [{ "t0": 0.6, "t1": 4.3, "text": "……\n……" }],
  "outro": [{ "t0": 40.0, "t1": 46.6, "style": "Lead", "y": 392, "text": "所以" }],
  "beats": [
    { "id": "c01_split", "kind": "static", "img": "split_composite", "dur": 8.0 },
    { "id": "c02_cross", "kind": "still",  "img": "10c_chopstick_cross", "dur": 3.5,
      "z0": 1.0, "z1": 1.05,           // 缩放起止
      "panX": 0, "panY": 0,            // 平移（源像素）
      "shake": false,                  // 手持抖动
      "freeze": 0,                     // 推到这个秒数后定格
      "grade": "neutral",              // neutral | heaven | hellCold | title
      "grain": 6, "bloom": false,      // 颗粒强度 / 柔光
      "fadeIn": 0, "fadeOut": 0 }
  ]
}
```

`dur` 之和就是片长；改完直接 `node build.mjs`，字幕时间码、配乐长度都会跟着走。

## 两个"看图"工具

### `describe_image.mjs` — 把图读成结构化文字

```bash
VISION_MODEL=gpt-6-sol node pipeline/tools/describe_image.mjs path/to/img.png
```

输出画风、角色清单、色板、构图、可复用的英文提示词片段。**写提示词前先跑一遍锚点图**，这一步能省掉大量试错。

### `qa_vision.mjs` — 验收

```bash
node pipeline/tools/qa_vision.mjs "画面里有几个人？筷子够长吗？" a.png b.png
```

出图后立刻问几个具体问题（角色数、配色、有无断肢/穿模），比肉眼快。

> 这两个工具需要一个支持图片输入的 chat 模型；环境变量：`VISION_BASE`（默认同 `IMG_BASE`）、`VISION_API_KEY`（默认同 `IMG_API_KEY`）、`VISION_MODEL`。
