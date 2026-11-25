import * as THREE from 'three'
import { P } from '../game/config.js'
import { paint, place, box, cyl, ball, cone, torus, disc, mergeAll, blob, shadeBand } from './geo.js'
import { rand, pick, FOLIAGE } from './props.js'

// ============================================================================
// Flora kit: trees, bushes, hedges, potted plants (moved out of props.js so the
// nature build can own them). Same conventions as props.js:
//  - every builder takes (out, x, y, z, ...): y is the terrain height
//  - trunks / pots go to `out` (static solids, inked); canopies go to FOLIAGE,
//    which town.js merges into ONE wind-swayed draw call
//  - `rand` / `pick` are the shared seeded RNG from props.js (cycle-safe: they
//    are only used inside functions, after both modules have evaluated)
// ============================================================================

export function plant(out, x, y, z, s = 1) {
  const g = []
  g.push(cyl(0.15 * s, 0.11 * s, 0.24 * s, 10, '#B5673F', 0, 0.12 * s, 0))
  g.push(cyl(0.165 * s, 0.165 * s, 0.04 * s, 10, '#C4673F', 0, 0.24 * s, 0))
  g.push(blob(0.19 * s, pick([P.sage, P.sageDeep, P.forest]), 0, 0.4 * s, 0, { sy: 1.15 }))
  if (rand() < 0.4) g.push(blob(0.08 * s, P.coral, 0.1 * s, 0.5 * s, 0.08 * s))
  const m = mergeAll(g)
  place(m, x, y, z)
  out.push(m)
}

// Round-crowned town tree: smooth overlapping blobs. `gold` = a citrus tree
// with orange fruit (the brand colour, growing).
export function tree(out, x, y, z, s = 1, gold = false) {
  const ry = rand() * 6.28
  const trunk = cyl(0.08 * s, 0.14 * s, 1.5 * s, 8, '#7A6455', 0, 0.75 * s, 0)
  place(trunk, x, y, z, { ry })
  out.push(trunk)
  const cols = gold ? ['#7F9468', '#6F8460', '#8FA37E'] : [P.sage, P.sageDeep, P.forest]
  const c = []
  c.push(blob(0.78 * s, cols[0], 0, 1.95 * s, 0, { sy: 0.86 }))
  c.push(blob(0.55 * s, cols[1], 0.48 * s, 1.6 * s, 0.1 * s))
  c.push(blob(0.48 * s, cols[2], -0.42 * s, 1.62 * s, -0.16 * s))
  c.push(blob(0.44 * s, cols[0], 0.05 * s, 1.7 * s, 0.5 * s))
  if (gold)
    for (let i = 0; i < 7; i++) {
      const a = rand() * 6.28
      const r = (0.55 + rand() * 0.25) * s
      c.push(place(paint(new THREE.SphereGeometry(0.075 * s, 6, 4), i % 2 ? '#E8904A' : P.coral), Math.cos(a) * r, (1.5 + rand() * 0.6) * s, Math.sin(a) * r))
    }
  const canopy = mergeAll(c)
  place(canopy, x, y, z, { ry })
  FOLIAGE.push(canopy)
}

// stone pine: a tall bare trunk under a wide flat umbrella crown
export function pine(out, x, y, z, s = 1) {
  const ry = rand() * 6.28
  const h = (4.2 + rand() * 1.6) * s
  const trunk = cyl(0.09 * s, 0.17 * s, h, 8, '#7A5F4A', 0, h / 2, 0, { rz: (rand() - 0.5) * 0.08 })
  place(trunk, x, y, z, { ry })
  out.push(trunk)
  const br = []
  br.push(cyl(0.04 * s, 0.06 * s, 1.3 * s, 6, '#7A5F4A', 0.45 * s, h * 0.82, 0, { rz: -0.8 }))
  br.push(cyl(0.035 * s, 0.05 * s, 1.1 * s, 6, '#7A5F4A', -0.4 * s, h * 0.84, 0.1 * s, { rz: 0.85 }))
  const brm = mergeAll(br)
  place(brm, x, y, z, { ry })
  out.push(brm)
  const cols = [P.forest, P.sageDeep, '#5E7552']
  const c = []
  c.push(blob(1.25 * s, cols[0], 0, h * 0.97, 0, { sy: 0.42 }))
  c.push(blob(0.85 * s, cols[1], 0.75 * s, h * 0.93, 0.2 * s, { sy: 0.45 }))
  c.push(blob(0.8 * s, cols[2], -0.7 * s, h * 0.94, -0.25 * s, { sy: 0.45 }))
  c.push(blob(0.7 * s, cols[1], 0.1 * s, h * 1.03, -0.5 * s, { sy: 0.45 }))
  const canopy = mergeAll(c)
  place(canopy, x, y, z, { ry })
  FOLIAGE.push(canopy)
}

// cypress: the tall dark exclamation mark of every Mediterranean skyline
export function cypress(out, x, y, z, s = 1) {
  const h = (4.4 + rand() * 1.8) * s
  out.push(cyl(0.07 * s, 0.1 * s, 0.6 * s, 6, '#6E5A44', x, y + 0.3 * s, z))
  const c = []
  c.push(place(paint(new THREE.SphereGeometry(0.5 * s, 12, 12), P.forest), 0, 0.4 * s + h * 0.5, 0, { sy: h / (1.0 * s) }))
  c.push(place(paint(new THREE.SphereGeometry(0.36 * s, 10, 10), '#5A7050'), 0.1 * s, 0.4 * s + h * 0.42, 0.08 * s, { sy: (h * 0.7) / (0.72 * s) }))
  const canopy = mergeAll(c)
  place(canopy, x, y, z, { ry: rand() * 6.28 })
  FOLIAGE.push(canopy)
}

// olive: short gnarled trunk, silvery crown
export function olive(out, x, y, z, s = 1) {
  const ry = rand() * 6.28
  const t = mergeAll([
    cyl(0.1 * s, 0.17 * s, 0.9 * s, 7, '#84705C', 0, 0.45 * s, 0, { rz: 0.12 }),
    cyl(0.06 * s, 0.09 * s, 0.7 * s, 6, '#84705C', 0.22 * s, 1.05 * s, 0, { rz: -0.6 }),
    cyl(0.05 * s, 0.08 * s, 0.6 * s, 6, '#84705C', -0.2 * s, 1.05 * s, 0.05 * s, { rz: 0.6 }),
  ])
  place(t, x, y, z, { ry })
  out.push(t)
  const cols = ['#A9B79C', '#94A688', '#B7C3AA']
  const c = []
  c.push(blob(0.6 * s, cols[0], 0.3 * s, 1.55 * s, 0, { sy: 0.8 }))
  c.push(blob(0.55 * s, cols[1], -0.32 * s, 1.5 * s, 0.1 * s, { sy: 0.8 }))
  c.push(blob(0.45 * s, cols[2], 0, 1.85 * s, -0.1 * s, { sy: 0.8 }))
  const canopy = mergeAll(c)
  place(canopy, x, y, z, { ry })
  FOLIAGE.push(canopy)
}

// bougainvillea tree: a crown in the festival orange
export function blossom(out, x, y, z, s = 1) {
  const ry = rand() * 6.28
  const trunk = cyl(0.08 * s, 0.13 * s, 1.4 * s, 7, '#7A6455', 0, 0.7 * s, 0)
  place(trunk, x, y, z, { ry })
  out.push(trunk)
  const cols = ['#E08A6A', P.coral, '#E9A088', P.sage]
  const c = []
  c.push(blob(0.72 * s, cols[0], 0, 1.82 * s, 0, { sy: 0.82 }))
  c.push(blob(0.5 * s, cols[1], 0.42 * s, 1.52 * s, 0.1 * s))
  c.push(blob(0.44 * s, cols[2], -0.4 * s, 1.56 * s, -0.1 * s))
  c.push(blob(0.36 * s, cols[3], 0.05 * s, 1.42 * s, -0.42 * s))
  const canopy = mergeAll(c)
  place(canopy, x, y, z, { ry })
  FOLIAGE.push(canopy)
}

// leaning palm for the beach — fronds sway with the wind bucket
export function palm(out, x, y, z, s = 1) {
  const ry = rand() * 6.28
  const lean = 0.14 + rand() * 0.12
  const t = []
  for (let i = 0; i < 4; i++)
    t.push(cyl(0.11 * s - i * 0.015, 0.13 * s - i * 0.015, 0.85 * s, 7, i % 2 ? '#8A7050' : '#7A6455', Math.sin(lean) * i * 0.8 * s, (0.4 + i * 0.78) * s, 0, { rz: -lean }))
  const trunk = mergeAll(t)
  place(trunk, x, y, z, { ry })
  out.push(trunk)
  const topX = Math.sin(lean) * 3.1 * s
  const topY = (0.4 + 3.6 * 0.78) * s
  const f = []
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    f.push(
      place(paint(new THREE.BoxGeometry(1.7 * s, 0.06 * s, 0.42 * s), i % 2 ? P.sage : P.sageDeep), 0.75 * s, 0, 0, {
        rz: -0.45 - rand() * 0.2,
      }).rotateY(a)
    )
  }
  f.push(ball(0.12 * s, '#6E5A44', 0.1 * s, -0.05 * s, 0.08 * s))
  f.push(ball(0.12 * s, '#6E5A44', -0.1 * s, -0.08 * s, -0.06 * s))
  const fronds = mergeAll(f)
  place(fronds, topX, topY, 0)
  place(fronds, x, y, z, { ry })
  FOLIAGE.push(fronds)
}

// a run of clipped hedge with softly rounded tops; collider is the caller's job
export function hedgeRow(out, x, y, z, len, ry, h = 0.75) {
  const g = []
  const n = Math.max(1, Math.round(len / 1.3))
  for (let i = 0; i < n; i++)
    g.push(place(paint(new THREE.SphereGeometry(0.5, 10, 8), pick([P.sageDeep, P.forest, '#657B58'])), -len / 2 + (i + 0.5) * (len / n), h * 0.5, 0, { sx: (len / n) * 1.25, sy: h * (0.95 + rand() * 0.2), sz: 0.72 }))
  const m = mergeAll(g)
  place(m, x, y, z, { ry })
  out.push(m)
}
