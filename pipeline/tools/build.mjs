#!/usr/bin/env node
/**
 * build.mjs — 从关键帧 + 时间轴计划合成成片
 *
 * 流程: 分屏合成 -> 运镜片段 -> 拼接 -> 烧字幕 -> 三段式配乐 -> 成片
 *
 * 用法:
 *   node build.mjs               # 增量构建（已有片段直接复用）
 *   FORCE=1 node build.mjs       # 强制重渲全部片段
 *   REMUX_ONLY=1 node build.mjs  # 只重做音轨并重新封装（不重编码画面）
 *
 * 依赖: ffmpeg / ffprobe 在 PATH 中；字体 msyhbd.ttc（Windows 自带）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..', '..')
const PLAN = join(PROJECT, 'script', 'plan.json')
const FRAMES = join(PROJECT, 'assets', 'keyframes')
const BUILD = join(PROJECT, 'video', '.build')
const OUT = join(PROJECT, 'video')
mkdirSync(BUILD, { recursive: true })

const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
const FPS = plan.fps
const W = plan.width
const H = plan.height
const CRF = String(plan.crf ?? 18)
const TOTAL = Number(plan.beats.reduce((s, b) => s + b.dur, 0).toFixed(3))

function run(args, label, cwd = PROJECT) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit', cwd })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + label)
}

/** 帧文件解析：优先 assets/keyframes，其次 video/.build（派生图） */
function framePath(id) {
  const a = join(FRAMES, id + '.png')
  if (existsSync(a)) return a
  const b = join(BUILD, id + '.png')
  if (existsSync(b)) return b
  throw new Error('missing frame: ' + id)
}

// 干跑：只打印时间轴与素材解析结果，不调用 ffmpeg
if (process.argv.includes('--dry-run')) {
  console.log(`plan: ${plan.beats.length} beats, ${TOTAL}s @ ${FPS}fps ${W}x${H}`)
  for (const b of plan.beats) {
    const img = b.kind === 'static' && b.img === 'split_composite' ? '(派生: 01b+02b)' : framePath(b.img)
    console.log(`  ${b.id.padEnd(12)} ${String(b.dur).padStart(5)}s  ${b.kind.padEnd(7)} ${img}`)
  }
  console.log(`narration blocks: ${plan.narr.length}, outro lines: ${plan.outro.length}`)
  process.exit(0)
}

const GRADES = {
  neutral: 'eq=contrast=1.03:saturation=1.02',
  heaven: 'eq=brightness=0.025:contrast=1.05:saturation=1.10,colorbalance=rs=0.03:gs=0.02:bs=-0.04',
  hellCold: "eq=brightness=-0.055:contrast=1.16:saturation=0.84,colorbalance=rs=-0.075:gs=-0.02:bs=0.17,curves=b='0/0 0.5/0.6 1/1'",
  title: 'eq=brightness=-0.01:contrast=1.06:saturation=0.95',
}

// 2 倍超采样：消除 zoompan 慢推镜的整像素抖动
const SS_W = W * 2
const SS_H = H * 2
const SRC_W = 4480
const SRC_H = 2520

function zoompan({ dur, z0 = 1.0, z1 = 1.0, panX = 0, panY = 0, shake = false, freeze = 0 }) {
  const frames = Math.round(dur * FPS)
  const span = freeze > 0 ? Math.max(1, Math.round(freeze * FPS)) : frames - 1
  let x = `iw/2-(iw/zoom/2)`
  let y = `ih/2-(ih/zoom/2)`
  if (panX) x += `+(${panX})*min(on/${span},1)`
  if (panY) y += `+(${panY})*min(on/${span},1)`
  if (shake) {
    x += `+sin(on*0.7)*10`
    y += `+cos(on*0.93)*7`
  }
  const zExpr = freeze > 0
    ? `min(${z0}+(${z1 - z0})*on/${span},${Math.max(z0, z1)})`
    : `${z0}+(${z1 - z0})*on/${span}`
  return `zoompan=z='${zExpr}':x='${x}':y='${y}':d=${frames}:s=${SS_W}x${SS_H}:fps=${FPS}`
}

function postChain({ grade = 'neutral', grain = 0, fadeIn = 0, fadeOut = 0, dur }) {
  const parts = [GRADES[grade] ?? GRADES.neutral]
  if (grain > 0) parts.push(`noise=alls=${grain}:allf=t`)
  parts.push('vignette=PI/5')
  if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fadeIn}`)
  if (fadeOut > 0) parts.push(`fade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut}`)
  return parts.join(',')
}

function stillFilter(b) {
  const pre = `[0:v]scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=increase,crop=${SRC_W}:${SRC_H},setsar=1,`
  const head = `${pre}${zoompan(b)},scale=${W}:${H}:flags=lanczos,${postChain(b)}`
  if (b.bloom) {
    return `${head},split[v1][v2];[v2]gblur=sigma=13[bl];[v1][bl]blend=all_mode=screen:all_opacity=0.18[v]`
  }
  return `${head}[v]`
}

function staticFilter(b) {
  const pre = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,`
  return `${pre}${postChain(b)}[v]`
}

// ---- 0. 派生图：左右分屏合成 ----
const splitSrc = ['01b_heaven_portrait', '02b_hell_portrait']
const splitOut = join(BUILD, 'split_composite.png')
if (!existsSync(splitOut)) {
  console.log('prepare split_composite')
  run([
    '-i', framePath(splitSrc[0]), '-i', framePath(splitSrc[1]),
    '-filter_complex',
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[l];` +
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[r];` +
      `[l][r]hstack=inputs=2,drawbox=x=${W - 3}:y=0:w=6:h=${H}:color=black@0.85:t=fill`,
    '-frames:v', '1', splitOut,
  ], 'split_composite')
}

// ---- 1. 逐镜渲染 ----
const clipFiles = []
for (const b of plan.beats) {
  const out = join(BUILD, b.id + '.mp4')
  if (existsSync(out) && !process.env.FORCE) {
    console.log(`reuse ${b.id}`)
    clipFiles.push(out)
    continue
  }
  const filterFile = join(BUILD, b.id + '.filter.txt')
  const graph = b.kind === 'static' ? staticFilter(b) : stillFilter(b)
  writeFileSync(filterFile, graph, 'utf8')
  console.log(`render ${b.id}  ${b.dur.toFixed(2)}s  (${b.kind})`)
  // 静态镜头没有 zoompan 造帧，必须 -loop 1
  const inputArgs = b.kind === 'static'
    ? ['-loop', '1', '-i', framePath(b.img)]
    : ['-i', framePath(b.img)]
  run([
    ...inputArgs,
    '-filter_complex_script', filterFile,
    '-map', '[v]',
    '-t', b.dur.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF, '-pix_fmt', 'yuv420p',
    '-an',
    out,
  ], b.id)
  clipFiles.push(out)
}

// ---- 2. 拼接 ----
const listFile = join(BUILD, 'concat.txt')
writeFileSync(listFile, clipFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
const concatFile = join(BUILD, 'concat.mp4')
console.log('concat')
run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile], 'concat')

// ---- 3. 字幕 ----
const ts = (s) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(2).padStart(5, '0')
  return `${h}:${String(m).padStart(2, '0')}:${sec}`
}
const ass = [
  '[Script Info]',
  'ScriptType: v4.00+',
  `PlayResX: ${W}`,
  `PlayResY: ${H}`,
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Narr,Microsoft YaHei,56,&H00FFFFFF,&H000000FF,&H00101010,&H99000000,1,0,0,0,100,100,0.6,0,1,3.8,2.2,2,90,90,92,1',
  'Style: Lead,Microsoft YaHei,48,&H00E4DCCF,&H000000FF,&H00101010,&H99000000,0,0,0,0,100,100,3,0,1,2.8,1.6,5,80,80,0,1',
  'Style: Lead2,Microsoft YaHei,56,&H00F2ECE2,&H000000FF,&H00101010,&H99000000,0,0,0,0,100,100,2.4,0,1,3.2,2,5,80,80,0,1',
  'Style: Title,Microsoft YaHei,74,&H00FFFFFF,&H000000FF,&H00080808,&HA0000000,1,0,0,0,100,100,1.8,0,1,4,2.8,5,80,80,0,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
]
for (const n of plan.narr) {
  ass.push(`Dialogue: 0,${ts(n.t0)},${ts(n.t1)},Narr,,0,0,0,,{\\fad(450,450)}${n.text.replace(/\n/g, '\\N')}`)
}
for (const o of plan.outro) {
  const fade = o.style === 'Title' ? '\\fad(900,700)' : o.style === 'Lead2' ? '\\fad(700,700)' : '\\fad(600,700)'
  ass.push(`Dialogue: 1,${ts(o.t0)},${ts(o.t1)},${o.style},,0,0,0,,{\\an5\\pos(${W / 2},${o.y})${fade}}${o.text}`)
}
writeFileSync(join(BUILD, 'subs.ass'), ass.join('\n'), 'utf8')

// ---- 4. 配乐：暖 -> 冷 -> 收（尾段长度随片长自适应）----
const WARM_D = 28
const COLD_D = 15
const X1 = 2
const X2 = 1.5
const END_D = Number((TOTAL - (WARM_D + COLD_D - X1 - X2)).toFixed(2))
const musicFile = join(BUILD, 'music.wav')
const warmBed = `aevalsrc='0.055*sin(2*PI*130.81*t)+0.05*sin(2*PI*196*t)+0.042*sin(2*PI*261.63*t)*(0.7+0.3*sin(2*PI*0.13*t))+0.034*sin(2*PI*329.63*t)+0.022*sin(2*PI*392*t)*(0.6+0.4*sin(2*PI*0.09*t))+0.012*sin(2*PI*523.25*t)':s=48000:d=${WARM_D}`
const coldBed = `aevalsrc='0.20*sin(2*PI*55*t)*(0.55+0.45*sin(2*PI*0.3*t))+0.10*sin(2*PI*82.5*t)+0.05*sin(2*PI*110*t)+0.03*random(0)*sin(2*PI*0.2*t)':s=48000:d=${COLD_D}`
const endBed = `aevalsrc='0.05*sin(2*PI*261.63*t)*exp(-0.10*t)+0.035*sin(2*PI*392*t)*exp(-0.13*t)+0.02*sin(2*PI*523.25*t)*exp(-0.18*t)+0.012*sin(2*PI*1046.5*t)*exp(-0.8*t)+0.022*sin(2*PI*130.81*t)':s=48000:d=${END_D}`
const musicGraph = [
  `[0:a]lowpass=f=3400,aecho=0.85:0.9:220|430|690:0.30|0.20|0.11,aformat=channel_layouts=stereo[w]`,
  `[1:a]lowpass=f=300,lowpass=f=300,aecho=0.8:0.9:180|340:0.28|0.18,aformat=channel_layouts=stereo[c]`,
  `[2:a]lowpass=f=4200,aecho=0.8:0.9:300|520:0.30|0.16,aformat=channel_layouts=stereo[e]`,
  `[w][c]acrossfade=d=${X1}:c1=tri:c2=tri[wc]`,
  `[wc][e]acrossfade=d=${X2}:c1=tri:c2=tri[m]`,
  `[m]volume=1.78,afade=t=in:st=0:d=1.2,afade=t=out:st=${(TOTAL - 2.2).toFixed(2)}:d=2.2[a]`,
].join(';')
console.log('music', TOTAL + 's')
run([
  '-f', 'lavfi', '-i', warmBed,
  '-f', 'lavfi', '-i', coldBed,
  '-f', 'lavfi', '-i', endBed,
  '-filter_complex', musicGraph,
  '-map', '[a]', '-t', String(TOTAL), '-ar', '48000', '-ac', '2',
  musicFile,
], 'music')

// ---- 5. 成片 ----
const finalFile = join(OUT, `heaven-hell-chopsticks-${Math.round(TOTAL)}s.mp4`)
const gradH = Math.round(H * 0.42)
const gradFile = join(BUILD, 'grad.png')
if (!existsSync(gradFile)) {
  run(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${gradH}:d=1`, '-vf', `format=rgba,geq=r=0:g=0:b=0:a='200*(Y/${gradH})'`, '-frames:v', '1', gradFile], 'grad')
}
const fontsDir = join(BUILD, 'fonts')
mkdirSync(fontsDir, { recursive: true })
const sysFont = 'C:\\Windows\\Fonts\\msyhbd.ttc'
if (existsSync(sysFont) && !existsSync(join(fontsDir, 'msyhbd.ttc'))) copyFileSync(sysFont, join(fontsDir, 'msyhbd.ttc'))

if (process.env.REMUX_ONLY && existsSync(finalFile)) {
  const staged = join(BUILD, 'remux.mp4')
  run(['-i', finalFile, '-i', musicFile, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', staged], 'remux')
  copyFileSync(staged, finalFile)
  console.log('REMUXED', finalFile)
  process.exit(0)
}

console.log('burn + mix ->', finalFile)
run([
  '-i', 'concat.mp4',
  '-i', 'grad.png',
  '-i', 'music.wav',
  '-filter_threads', '1',
  '-filter_complex', `[0:v][1:v]overlay=0:H-h[vg];[vg]subtitles=subs.ass:fontsdir=fonts[v]`,
  '-map', '[v]', '-map', '2:a',
  '-threads', '2',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF, '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-shortest', '-movflags', '+faststart',
  finalFile,
], 'final', BUILD)
console.log('DONE', finalFile)
