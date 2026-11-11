#!/usr/bin/env node
/**
 * batch_frames.mjs — 按 pipeline/frames.json 批量生成关键帧（串行，已存在则跳过）
 *
 * 用法:
 *   node batch_frames.mjs             # 生成全部缺失的关键帧
 *   node batch_frames.mjs 10a_heaven_full 10b_hell_starved
 *
 * 依赖环境变量 IMG_BASE / IMG_API_KEY（见 gen_image.mjs）
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..', '..')
const IMG = join(HERE, 'gen_image.mjs')
const OUT = join(PROJECT, 'assets', 'keyframes')
const manifest = JSON.parse(readFileSync(join(PROJECT, 'pipeline', 'frames.json'), 'utf8'))

const want = process.argv.slice(2)
const list = want.length ? want : manifest.frames.map((f) => f.id)
const byId = new Map(manifest.frames.map((f) => [f.id, f]))

for (const id of list) {
  const frame = byId.get(id)
  if (!frame) { console.error('unknown frame', id); continue }
  const out = join(OUT, id + '.png')
  if (existsSync(out)) { console.log('skip', id); continue }
  const args = [IMG, '--prompt', frame.prompt, '--size', frame.size, '--out', out]
  if (frame.ref) args.push('--ref', join(PROJECT, frame.ref))
  console.log('gen', id)
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: PROJECT })
  if (r.status !== 0) console.error('FAILED', id)
}
console.log('done')
