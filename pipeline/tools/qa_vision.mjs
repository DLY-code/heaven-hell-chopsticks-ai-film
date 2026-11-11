#!/usr/bin/env node
/**
 * qa_vision.mjs — 用视觉模型验收出图：问具体问题，避免"看起来还行"。
 *
 * 用法:
 *   node qa_vision.mjs "<问题>" img1.png [img2.png ...]
 *
 * 例:
 *   node qa_vision.mjs "画面里有几个角色？筷子是否够长？有无断肢或穿模？" a.png b.png
 *
 * 环境变量: VISION_BASE / VISION_API_KEY / VISION_MODEL（同 describe_image.mjs）
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const BASE = (process.env.VISION_BASE || process.env.IMG_BASE || '').replace(/\/+$/, '')
const KEY = process.env.VISION_API_KEY || process.env.IMG_API_KEY || ''
const MODEL = process.env.VISION_MODEL || 'gpt-6-sol'
const TMP = join(process.cwd(), '.qa-cache')

const question = process.argv[2]
const files = process.argv.slice(3)
if (!question || files.length === 0) {
  console.error('usage: node qa_vision.mjs "<question>" <img1> [img2 ...]')
  process.exit(2)
}
if (!BASE || !KEY) {
  console.error('missing env: VISION_BASE / VISION_API_KEY')
  process.exit(2)
}

mkdirSync(TMP, { recursive: true })

for (const f of files) {
  if (!existsSync(f)) { console.log('MISSING', f); continue }
  // 先缩到 560px 宽：视觉接口对大图容易超时
  const small = join(TMP, basename(f).replace(/\.\w+$/, '') + '.jpg')
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-vf', 'scale=560:-1', '-q:v', '5', small], { stdio: 'inherit' })
  if (!existsSync(small)) { console.log('CONVERT FAILED', f); continue }
  const b64 = readFileSync(small).toString('base64')
  let out = ''
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: question },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
            ],
          }],
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(120000),
      })
      const t = await r.text()
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 150)}`)
      out = JSON.parse(t)?.choices?.[0]?.message?.content ?? ''
      break
    } catch (e) {
      out = 'ERR ' + e.message
      await new Promise((res) => setTimeout(res, 2500))
    }
  }
  console.log(`\n### ${basename(f)}\n${out}`)
}
process.exit(0)
