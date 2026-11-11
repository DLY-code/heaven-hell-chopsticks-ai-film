#!/usr/bin/env node
/**
 * describe_image.mjs — 用视觉模型把本地图片读成结构化文字（写提示词 / 验收时用）
 *
 * 用法:
 *   node describe_image.mjs <imagePath> [自定义提问]
 *
 * 环境变量:
 *   VISION_BASE     默认取 IMG_BASE
 *   VISION_API_KEY  默认取 IMG_API_KEY
 *   VISION_MODEL    默认 gpt-6-sol
 */
import { readFileSync, existsSync } from 'node:fs'
import { extname, basename } from 'node:path'

const BASE = (process.env.VISION_BASE || process.env.IMG_BASE || '').replace(/\/+$/, '')
const KEY = process.env.VISION_API_KEY || process.env.IMG_API_KEY || ''
const MODEL = process.env.VISION_MODEL || 'gpt-6-sol'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

const imgPath = process.argv[2]
if (!imgPath || !existsSync(imgPath)) {
  console.error('usage: node describe_image.mjs <imagePath> [prompt]')
  process.exit(2)
}
if (!BASE || !KEY) {
  console.error('missing env: VISION_BASE / VISION_API_KEY (or IMG_BASE / IMG_API_KEY)')
  process.exit(2)
}

const DEFAULT_PROMPT = `你是分镜美术指导。请极详细描述这张图，供后续 AI 生成"同一批角色"的连续镜头使用。中文输出，不要寒暄：
1. 画风（卡通/写实、线条风格、上色方式、渲染质感）
2. 角色清单：从左到右逐个写——身份、体型比例、头身比、脸型五官、肤色、发色发型、服饰配饰、表情、姿势、手中物品
3. 场景与道具（桌、食物、餐具、环境）
4. 色彩：主色/辅色/点缀色，给出近似十六进制色号；光源方向与色温
5. 构图与镜头：视角、景别、透视
6. 角色一致性关键词：每个角色写一段 40 字以内英文 prompt 片段`

const prompt = process.argv[3] ?? DEFAULT_PROMPT
const mime = MIME[extname(imgPath).toLowerCase()] ?? 'image/jpeg'
const b64 = readFileSync(imgPath).toString('base64')

async function once() {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      }],
      max_tokens: 1400,
    }),
    signal: AbortSignal.timeout(150000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const payload = JSON.parse(text)
  const msg = payload?.choices?.[0]?.message?.content
  if (!msg) throw new Error('empty content')
  return typeof msg === 'string' ? msg : JSON.stringify(msg)
}

let lastErr
for (let i = 1; i <= 3; i++) {
  try {
    console.log(`\n### ${basename(imgPath)}\n${await once()}`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.error(`attempt ${i}: ${e.message}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
}
console.error('ERR', lastErr?.message)
process.exit(1)
