#!/usr/bin/env node
/**
 * gen_image.mjs — 文生图 / 图生图（OpenAI 兼容 images 路由）
 *
 * 用法:
 *   node gen_image.mjs --prompt "..." --out out.png [--size 1536x1024] [--model gpt-image-2]
 *                      [--ref anchor.png ...] [--quality high]
 *
 * 环境变量:
 *   IMG_BASE     接口地址，例如 https://your-relay.example.com/v1
 *   IMG_API_KEY  密钥
 *   IMG_MODEL    默认模型（可被 --model 覆盖），默认 gpt-image-2
 *
 * 无 --ref 走 POST {base}/images/generations；有 --ref 走 POST {base}/images/edits（multipart）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, extname, resolve } from 'node:path'

const BASE = (process.env.IMG_BASE || '').replace(/\/+$/, '')
const KEY = process.env.IMG_API_KEY || ''
const DEFAULT_MODEL = process.env.IMG_MODEL || 'gpt-image-2'

function parseArgs(argv) {
  const out = { prompt: '', out: '', size: '1536x1024', model: DEFAULT_MODEL, refs: [], quality: '', n: 1, timeout: 300000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--prompt') out.prompt = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--size') out.size = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--ref') out.refs.push(argv[++i])
    else if (a === '--quality') out.quality = argv[++i]
    else if (a === '--n') out.n = Number(argv[++i])
    else if (a === '--timeout') out.timeout = Number(argv[++i])
  }
  return out
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

const args = parseArgs(process.argv.slice(2))
if (!args.prompt || !args.out) {
  console.error('usage: gen_image.mjs --prompt "..." --out file.png [--ref src.png] [--size 1536x1024]')
  process.exit(2)
}
if (!BASE || !KEY) {
  console.error('missing env: IMG_BASE / IMG_API_KEY')
  process.exit(2)
}

async function attempt() {
  const t0 = Date.now()
  let res
  if (args.refs.length === 0) {
    const body = { model: args.model, prompt: args.prompt, n: args.n, size: args.size, response_format: 'b64_json' }
    if (args.quality) body.quality = args.quality
    res = await fetch(`${BASE}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeout),
    })
  } else {
    const fd = new FormData()
    fd.set('model', args.model)
    fd.set('prompt', args.prompt)
    fd.set('n', String(args.n))
    fd.set('size', args.size)
    if (args.quality) fd.set('quality', args.quality)
    for (const ref of args.refs) {
      const ext = extname(ref).toLowerCase()
      const buf = readFileSync(ref)
      fd.append('image[]', new Blob([buf], { type: MIME[ext] ?? 'image/png' }), 'ref' + ext)
    }
    res = await fetch(`${BASE}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
      body: fd,
      signal: AbortSignal.timeout(args.timeout),
    })
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  const payload = JSON.parse(text)
  const entry = (payload.data ?? [])[0]
  if (!entry) throw new Error('no data entry: ' + text.slice(0, 300))
  let buf
  if (typeof entry.b64_json === 'string' && entry.b64_json.length) buf = Buffer.from(entry.b64_json, 'base64')
  else if (typeof entry.url === 'string' && entry.url.startsWith('data:')) buf = Buffer.from(entry.url.split(',')[1], 'base64')
  else if (typeof entry.url === 'string') {
    const r2 = await fetch(entry.url, { signal: AbortSignal.timeout(120000) })
    buf = Buffer.from(await r2.arrayBuffer())
  } else throw new Error('no image payload')
  const abs = resolve(args.out)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buf)
  return { file: abs, bytes: buf.length, ms: Date.now() - t0, mode: args.refs.length ? 'edit' : 'gen' }
}

let lastErr
for (let i = 1; i <= 3; i++) {
  try {
    console.log(JSON.stringify(await attempt()))
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.error(`attempt ${i}: ${e.message}`)
    await new Promise((r) => setTimeout(r, 4000))
  }
}
console.error('ERR ' + lastErr?.message)
process.exit(1)
