import * as THREE from 'three'
import {
  mergeGeometries,
  mergeVertices,
} from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Deterministic rand so the town looks the same every load (mulberry32).
export function rng(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const _c = new THREE.Color()

// Surfaces that switch themselves on after dark. The whole town merges into ONE
// vertex-colored mesh, so a per-object emissive material is impossible without
// giving up the single draw call. Instead every vertex carries a lit mask, and
// the shared material adds emission where the mask is set (see bend.js uNight).
//
// Keyed off the PAINT COLOUR rather than a per-call-site flag: windows are
// already painted P.glass in 43 places across the districts, so this lights all
// of them — and anything added later — without touching a single district file.
const LIT_COLORS = new Set(['#3D4750'.toLowerCase()]) // P.glass: windows
const LAMP_COLOR = '#ffe2a8' // lamp globes / headlights: always on after dark
const _litRand = rng(9151)

// Bake a flat color into vertex colors — the whole static town merges into a
// single vertex-colored mesh (1 draw call for fills, 1 for ink lines).
// small(geo, yes): accents too thin to want an outline stay out of the ink hull
const small = (g, yes) => (yes ? noInk(g) : g)

// triangle tally per builder (dev tool: GEO_TALLY.on = true before buildTown)
export const GEO_TALLY = { on: false, n: {} }
const tally = (kind, g) => {
  if (GEO_TALLY.on) GEO_TALLY.n[kind] = (GEO_TALLY.n[kind] || 0) + (g.index ? g.index.count : g.attributes.position.count) / 3
  return g
}

export function paint(geo, hex, mul = 1) {
  _c.set(hex).multiplyScalar(mul)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _c.r
    arr[i * 3 + 1] = _c.g
    arr[i * 3 + 2] = _c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))

  // ⚠ EVERY painted geometry must carry this, even when it is zero:
  // mergeGeometries refuses a mix where some inputs have an attribute and
  // others do not, and the whole town goes through one merge.
  // Not every window is lit: about two in three come on, each at its own
  // warmth, so a street at night reads as lived-in instead of a uniform grid.
  let lit = 0
  if (typeof hex === 'string' && hex.toLowerCase() === LAMP_COLOR) lit = 1
  else if (typeof hex === 'string' && LIT_COLORS.has(hex.toLowerCase())) {
    const r = _litRand()
    lit = r < 0.34 ? 0 : 0.45 + _litRand() * 0.55
  }
  const la = new Float32Array(n)
  if (lit) la.fill(lit)
  geo.setAttribute('aLit', new THREE.BufferAttribute(la, 1))
  return geo
}

export function place(geo, x, y, z, { rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz)
  if (rx) geo.rotateX(rx)
  if (rz) geo.rotateZ(rz)
  if (ry) geo.rotateY(ry)
  geo.translate(x, y, z)
  return geo
}

// ---------------------------------------------------------------------------
// box: the workhorse. SOFT BY DEFAULT (owner: "not boxy, not edgy"): every
// solid box is chamfered with smooth normals across the chamfer, so the toon
// step rolls round the edge and the ink hull follows a rounded silhouette.
//   - a full box (all sides >= 0.1): 44 triangles, every edge and corner cut
//   - a plate (one thin side, the other two >= 0.3): its four corners are
//     rounded in plan (28 triangles): table tops, awning slats, sign boards
//   - sticks and slivers stay raw (12 triangles): too small to read
// Opt out with opts.flat = true (ground decals, road paint, anything that must
// tile edge to edge) or opts.seg = [sx, sy, sz] (subdivided ground slabs:
// REQUIRED for long ground pieces, since the world-bend is per-vertex).
// opts.r overrides the bevel radius.
// ---------------------------------------------------------------------------
let SOFT = 1 // 1 = full, 0 = raw boxes everywhere (the phone preset keeps 1: it is cheap)
export const setSoft = (v) => (SOFT = v)
const _tn = new THREE.Vector3()
const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
function finishSoft(pos, nor, tris) {
  // fix every triangle's winding against its vertex normals
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3
    const b = tris[i + 1] * 3
    const c = tris[i + 2] * 3
    _e1.set(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2])
    _e2.set(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2])
    _tn.crossVectors(_e1, _e2)
    const d = _tn.x * (nor[a] + nor[b] + nor[c]) + _tn.y * (nor[a + 1] + nor[b + 1] + nor[c + 1]) + _tn.z * (nor[a + 2] + nor[b + 2] + nor[c + 2])
    if (d < 0) {
      const t = tris[i + 1]
      tris[i + 1] = tris[i + 2]
      tris[i + 2] = t
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2))
  g.setIndex(tris)
  return g
}
// every edge and corner cut by r (44 triangles)
export function chamferBoxGeo(w, h, d, r) {
  const A = [w / 2, h / 2, d / 2]
  const pos = []
  const nor = []
  const tris = []
  // vertex id: corner (0..7) * 3 + face axis
  const id = (sx, sy, sz, k) => ((sx > 0 ? 1 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 4 : 0)) * 3 + k
  for (let c = 0; c < 8; c++) {
    const s = [c & 1 ? 1 : -1, c & 2 ? 1 : -1, c & 4 ? 1 : -1]
    for (let k = 0; k < 3; k++) {
      for (let t = 0; t < 3; t++) {
        pos.push(s[t] * (t === k ? A[t] : A[t] - r))
        nor.push(t === k ? s[t] : 0)
      }
    }
  }
  const S = [-1, 1]
  // faces
  for (let k = 0; k < 3; k++) {
    for (const sk of S) {
      const v = []
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const s = [0, 0, 0]
        s[k] = sk
        s[(k + 1) % 3] = a
        s[(k + 2) % 3] = b
        v.push(id(s[0], s[1], s[2], k))
      }
      tris.push(v[0], v[1], v[2], v[0], v[2], v[3])
    }
  }
  // edges: between face axes k and k2, running along the third axis
  for (let k = 0; k < 3; k++) {
    const k2 = (k + 1) % 3
    const k3 = (k + 2) % 3
    for (const a of S) {
      for (const b of S) {
        const s0 = [0, 0, 0]
        const s1 = [0, 0, 0]
        s0[k] = s1[k] = a
        s0[k2] = s1[k2] = b
        s0[k3] = -1
        s1[k3] = 1
        const v0 = id(s0[0], s0[1], s0[2], k)
        const v1 = id(s1[0], s1[1], s1[2], k)
        const v2 = id(s1[0], s1[1], s1[2], k2)
        const v3 = id(s0[0], s0[1], s0[2], k2)
        tris.push(v0, v1, v2, v0, v2, v3)
      }
    }
  }
  // corners
  for (let c = 0; c < 8; c++) tris.push(c * 3, c * 3 + 1, c * 3 + 2)
  return finishSoft(pos, nor, tris)
}
// a thin plate (thin along axis k) whose four corners are rounded by r:
// n = 1 cuts each corner once (28 triangles), n = 3 makes it a true round
// corner (windows, screens, sign boards)
export function plateGeo(w, h, d, r, k, n = 1) {
  const A = [w / 2, h / 2, d / 2]
  const u = (k + 1) % 3
  const v = (k + 2) % 3
  const pos = []
  const nor = []
  const tris = []
  // the outline, counter-clockwise in (u, v), with its side normals
  const ring = []
  const C = [[1, 1, 0], [-1, 1, 1], [-1, -1, 2], [1, -1, 3]]
  for (const [su, sv, q] of C) {
    for (let i = 0; i <= n; i++) {
      const a = (q + i / n) * (Math.PI / 2)
      const cu = Math.cos(a)
      const cv = Math.sin(a)
      ring.push([su * (A[u] - r) + cu * r, sv * (A[v] - r) + cv * r, n === 1 ? (i === 0 ? (q % 2 ? 0 : su) : q % 2 ? su : 0) : cu, n === 1 ? (i === 0 ? (q % 2 ? sv : 0) : q % 2 ? 0 : sv) : cv])
    }
  }
  const put = (pu, pv, pk, nu, nv, nk) => {
    const p = [0, 0, 0]
    const nn = [0, 0, 0]
    p[u] = pu
    p[v] = pv
    p[k] = pk
    nn[u] = nu
    nn[v] = nv
    nn[k] = nk
    pos.push(...p)
    nor.push(...nn)
    return pos.length / 3 - 1
  }
  const side = []
  const cap = [[], []]
  for (const [pu, pv, nu, nv] of ring) {
    side.push([put(pu, pv, -A[k], nu, nv, 0), put(pu, pv, A[k], nu, nv, 0)])
    cap[0].push(put(pu, pv, -A[k], 0, 0, -1))
    cap[1].push(put(pu, pv, A[k], 0, 0, 1))
  }
  const m = ring.length
  for (let i = 0; i < m; i++) {
    const a = side[i]
    const b = side[(i + 1) % m]
    tris.push(a[0], b[0], b[1], a[0], b[1], a[1])
  }
  for (const c of cap) for (let i = 1; i < m - 1; i++) tris.push(c[0], c[i], c[i + 1])
  return finishSoft(pos, nor, tris)
}
export function softBoxGeo(w, h, d, r) {
  const dims = [w, h, d]
  const mn = Math.min(w, h, d)
  const mx = Math.max(w, h, d)
  const k = dims.indexOf(mn)
  const mid = w + h + d - mn - mx
  if (mn >= 0.1) return chamferBoxGeo(w, h, d, r ?? Math.min(mn * 0.3, 0.045 + mx * 0.018, 0.2))
  // an explicit, generous radius asks for a true round corner
  if (mid >= 0.3 && mn > 0.011) return plateGeo(w, h, d, Math.min(r ?? Math.min(mid * 0.3, 0.05 + mx * 0.02, 0.14), mid * 0.5), k, r && r >= 0.1 ? 3 : 1)
  return null
}
export function box(w, h, d, color, x, y, z, opts = {}) {
  let g = null
  if (SOFT && !opts.seg && !opts.flat) g = softBoxGeo(Math.abs(w), Math.abs(h), Math.abs(d), opts.r)
  if (!g) g = new THREE.BoxGeometry(w, h, d, ...(opts.seg || []))
  if (GEO_TALLY.on) {
    const mx = Math.max(Math.abs(w), Math.abs(h), Math.abs(d))
    const k = (g.index.count === 132 ? 'chamfer' : g.index.count === 36 ? 'raw' : 'plate') + (mx < 0.3 ? '<.3' : mx < 0.8 ? '<.8' : mx < 2 ? '<2' : '>2')
    GEO_TALLY.n[k] = (GEO_TALLY.n[k] || 0) + 1
  }
  place(paint(g, color), x, y, z, opts)
  // accents too small to want an outline (slats, planks, knobs) stay out of the ink hull
  // (slats, planks, knobs: all sides small; rods and bars: two sides thin)
  if (opts.ink !== true) {
    const a = Math.abs(w)
    const b = Math.abs(h)
    const c = Math.abs(d)
    const mx = Math.max(a, b, c)
    const mid = a + b + c - mx - Math.min(a, b, c)
    if (opts.ink === false || mx < 0.14 || mid < 0.07) noInk(g)
  }
  return tally('box', g)
}
// the raw box, for call sites that must never be softened
export const rawBox = (w, h, d, color, x, y, z, opts = {}) => box(w, h, d, color, x, y, z, { ...opts, flat: true })

// cylinders: thick ones get enough sides that the silhouette is a curve, not a
// polygon (the toon step and the ink hull both show every facet)
export const cyl = (rt, rb, h, seg, color, x, y, z, opts) =>
  tally('cyl', place(small(paint(new THREE.CylinderGeometry(rt, rb, h, Math.max(rt, rb) > 0.3 ? Math.max(seg, 16) : Math.max(rt, rb) > 0.09 ? Math.max(seg, 10) : Math.min(seg, 6)), color), Math.max(rt, rb) < 0.035), x, y, z, opts))

export const ball = (r, color, x, y, z, opts) =>
  tally('ball', place(small(paint(new THREE.SphereGeometry(r, r < 0.09 ? 6 : r < 0.22 ? 8 : 10, r < 0.09 ? 4 : r < 0.22 ? 6 : 8), color), r < 0.07), x, y, z, opts))

export const cone = (r, h, seg, color, x, y, z, opts) =>
  tally('cone', place(paint(new THREE.ConeGeometry(r, h, seg), color), x, y, z, opts))

export const torus = (r, t, color, x, y, z, opts) =>
  tally('torus', place(small(paint(new THREE.TorusGeometry(r, t, t < 0.05 ? 5 : 7, r < 0.2 ? 10 : r < 0.5 ? 14 : 20), color), t < 0.03), x, y, z, opts))

export const disc = (r, seg, color, x, y, z, opts) =>
  tally('disc', place(paint(new THREE.CircleGeometry(r, seg), color), x, y, z, opts))

// ORGANIC HELPERS (ported from ponyo.land's art/geo.js, the owner's own code):
// roundBox, wobble, lumpy, lathe, tube, sag, wire, vary, noise3, fbm3. See the
// comments on each. Everything is deterministic: pass a seed.
const _v = new THREE.Vector3()
// ---------------------------------------------------------------------------
// noise: hashed lattice value noise, smooth, seedable, allocation free
// ---------------------------------------------------------------------------
function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1440662683) ^ Math.imul(seed | 0, 0x27d4eb2d)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
const fade = (t) => t * t * (3 - 2 * t)
export function noise3(x, y, z, seed = 0) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = fade(x - ix)
  const fy = fade(y - iy)
  const fz = fade(z - iz)
  const a = hash3(ix, iy, iz, seed)
  const b = hash3(ix + 1, iy, iz, seed)
  const c = hash3(ix, iy + 1, iz, seed)
  const d = hash3(ix + 1, iy + 1, iz, seed)
  const e = hash3(ix, iy, iz + 1, seed)
  const f = hash3(ix + 1, iy, iz + 1, seed)
  const g = hash3(ix, iy + 1, iz + 1, seed)
  const h = hash3(ix + 1, iy + 1, iz + 1, seed)
  const x1 = a + (b - a) * fx
  const x2 = c + (d - c) * fx
  const x3 = e + (f - e) * fx
  const x4 = g + (h - g) * fx
  const y1 = x1 + (x2 - x1) * fy
  const y2 = x3 + (x4 - x3) * fy
  return y1 + (y2 - y1) * fz
}
export function fbm3(x, y, z, seed = 0, octaves = 3) {
  let s = 0
  let amp = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    s += noise3(x, y, z, seed + o * 101) * amp
    norm += amp
    amp *= 0.5
    x *= 2.03
    y *= 2.03
    z *= 2.03
  }
  return s / norm
}

function sizeOf(geo) {
  geo.computeBoundingBox()
  geo.boundingBox.getSize(_v)
  return Math.max(_v.x, _v.y, _v.z, 1e-3)
}

// ---------------------------------------------------------------------------
// roundBox: see the header
// ---------------------------------------------------------------------------
function roundAxis(a, r, n, m) {
  // offsets inside a corner zone, spaced so the arc is sampled evenly in angle
  const o = []
  for (let k = 0; k <= n; k++) o.push(r * Math.tan((k / n) * (Math.PI / 4)))
  const out = []
  const inner = a - r
  for (let k = n; k >= 1; k--) out.push(-inner - o[k])
  if (inner > 1e-6) for (let k = 0; k <= m; k++) out.push(-inner + (2 * inner * k) / m)
  else out.push(0)
  for (let k = 1; k <= n; k++) out.push(inner + o[k])
  return out
}
export function roundBox(w, h, d, radius = 0.08, segs = 2, color, x = 0, y = 0, z = 0, opts = {}) {
  const A = [w / 2, h / 2, d / 2]
  const r = Math.min(Math.max(radius, 0), Math.min(A[0], A[1], A[2]) * 0.999)
  if (r <= 1e-4) return rawBox(w, h, d, color, x, y, z, opts)
  const n = Math.max(1, Math.round(segs))
  const span = opts.maxSpan || 4
  const seg = opts.seg || []
  const C = A.map((a, k) => roundAxis(a, r, n, Math.max(1, seg[k] || Math.ceil((2 * (a - r)) / span))))
  let count = 0
  const faces = []
  for (let k = 0; k < 3; k++) {
    const ku = (k + 1) % 3
    const kv = (k + 2) % 3
    for (const s of [1, -1]) {
      faces.push({ k, ku, kv, s })
      count += C[ku].length * C[kv].length
    }
  }
  const pos = new Float32Array(count * 3)
  const nor = new Float32Array(count * 3)
  const uv = new Float32Array(count * 2)
  let tris = 0
  for (const f of faces) tris += (C[f.ku].length - 1) * (C[f.kv].length - 1) * 2
  const idx = new (count > 65535 ? Uint32Array : Uint16Array)(tris * 3)
  let vi = 0
  let ii = 0
  const p = [0, 0, 0]
  for (const { k, ku, kv, s } of faces) {
    const cu = C[ku]
    const cv = C[kv]
    const base = vi
    for (let j = 0; j < cv.length; j++) {
      for (let i = 0; i < cu.length; i++) {
        p[k] = s * A[k]
        p[ku] = cu[i]
        p[kv] = cv[j]
        // project onto the rounded shell: inner box + radius along the offset
        let ox = 0
        let oy = 0
        let oz = 0
        const q = [0, 0, 0]
        for (let t = 0; t < 3; t++) {
          const lim = A[t] - r
          q[t] = Math.min(lim, Math.max(-lim, p[t]))
        }
        ox = p[0] - q[0]
        oy = p[1] - q[1]
        oz = p[2] - q[2]
        const l = Math.hypot(ox, oy, oz) || 1
        pos[vi * 3] = q[0] + (ox / l) * r
        pos[vi * 3 + 1] = q[1] + (oy / l) * r
        pos[vi * 3 + 2] = q[2] + (oz / l) * r
        nor[vi * 3] = ox / l
        nor[vi * 3 + 1] = oy / l
        nor[vi * 3 + 2] = oz / l
        uv[vi * 2] = i / (cu.length - 1)
        uv[vi * 2 + 1] = j / (cv.length - 1)
        vi++
      }
    }
    const W = cu.length
    for (let j = 0; j < cv.length - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        const a = base + j * W + i
        const b = a + 1
        const c = a + W + 1
        const e = a + W
        if (s > 0) idx.set([a, b, c, a, c, e], ii)
        else idx.set([a, c, b, a, e, c], ii)
        ii += 6
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return tally('roundBox', place(paint(g, color), x, y, z, opts))
}

// ---------------------------------------------------------------------------
// wobble: see the header
// ---------------------------------------------------------------------------
export function wobble(geo, amount = 0.04, seed = 1, opts = {}) {
  const pos = geo.attributes.position
  const [ax, ay, az] = Array.isArray(amount) ? amount : [amount, amount, amount]
  const f = opts.freq || 1.2 / sizeOf(geo)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const px = x * f
    const py = y * f
    const pz = z * f
    pos.setXYZ(
      i,
      x + (noise3(px, py, pz, seed) - 0.5) * 2 * ax,
      y + (noise3(px + 17.3, py, pz, seed + 7) - 0.5) * 2 * ay,
      z + (noise3(px, py + 31.7, pz, seed + 13) - 0.5) * 2 * az,
    )
  }
  pos.needsUpdate = true
  if (opts.normals) geo.computeVertexNormals()
  geo.boundingBox = null
  geo.boundingSphere = null
  return geo
}

// ---------------------------------------------------------------------------
// lumpy: see the header
// ---------------------------------------------------------------------------
const _ico = new Map()
function weldedIco(detail) {
  if (!_ico.has(detail)) {
    let g = new THREE.IcosahedronGeometry(1, detail)
    g.deleteAttribute('uv')
    g.deleteAttribute('normal')
    g = mergeVertices(g, 1e-5)
    _ico.set(detail, g)
  }
  return _ico.get(detail).clone()
}
const _top = new THREE.Color()
const _bot = new THREE.Color()
export function lumpy(r = 1, detail = 2, amount = 0.18, seed = 1, color = '#FFFFFF', x = 0, y = 0, z = 0, opts = {}) {
  // never faceted: a blob big enough to show its outline gets the triangles for a round one
  const g = weldedIco(Math.max(r > 0.5 ? 3 : r > 0.13 ? 2 : 1, Math.min(8, detail | 0)))
  const pos = g.attributes.position
  const f = opts.freq || 1.6
  const so = seed * 13.37
  const base = opts.base
  const sx = opts.sx ?? 1
  const sy = opts.sy ?? 1
  const sz = opts.sz ?? 1
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i)
    const dy = pos.getY(i)
    const dz = pos.getZ(i)
    const nv = fbm3(dx * f + so, dy * f - so * 0.7, dz * f + so * 0.3, seed, 3)
    const k = r * (1 + amount * (nv - 0.5) * 2.4)
    let py = dy * k
    if (base !== undefined && py < base * r) py = base * r + (py - base * r) * 0.08
    pos.setXYZ(i, dx * k * sx, py * sy, dz * k * sz)
  }
  g.computeVertexNormals()
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2))
  paint(g, color)
  const col = g.attributes.color
  const nor = g.attributes.normal
  if (opts.top) _top.set(opts.top)
  if (opts.bottom) _bot.set(opts.bottom)
  const vr = opts.vary ?? 0.05
  for (let i = 0; i < pos.count; i++) {
    let cr = col.getX(i)
    let cg = col.getY(i)
    let cb = col.getZ(i)
    const ny = nor.getY(i)
    if (opts.top) {
      const t = fade(Math.min(1, Math.max(0, (ny - 0.1) / 0.75)))
      cr += (_top.r - cr) * t
      cg += (_top.g - cg) * t
      cb += (_top.b - cb) * t
    }
    if (opts.bottom) {
      const t = fade(Math.min(1, Math.max(0, (-ny - 0.15) / 0.7)))
      cr += (_bot.r - cr) * t
      cg += (_bot.g - cg) * t
      cb += (_bot.b - cb) * t
    }
    if (vr) {
      const m = 1 + (noise3(pos.getX(i) * 0.9 / r + so, pos.getY(i) * 0.9 / r, pos.getZ(i) * 0.9 / r, seed + 3) - 0.5) * 2 * vr
      cr *= m
      cg *= m
      cb *= m
    }
    col.setXYZ(i, cr, cg, cb)
  }
  return tally('lumpy', place(g, x, y, z, { rx: opts.rx, ry: opts.ry, rz: opts.rz }))
}

// ---------------------------------------------------------------------------
// lathe: see the header
// ---------------------------------------------------------------------------
export function lathe(profile, segs = 16, color = '#FFFFFF', x = 0, y = 0, z = 0, opts = {}) {
  let pts = profile.map((p) => (p.isVector2 ? p.clone() : new THREE.Vector2(Math.max(0, p[0]), p[1])))
  if (opts.smooth && pts.length > 2) pts = new THREE.SplineCurve(pts).getPoints((pts.length - 1) * Math.max(1, opts.smooth | 0))
  // enough sides that the silhouette is a curve (full turns only: wedges keep their count)
  let rmax = 0
  for (const q of pts) rmax = Math.max(rmax, q.x)
  const full = opts.phiLength === undefined
  const n = full ? Math.max(segs | 0, rmax > 0.6 ? 24 : rmax > 0.26 ? 16 : rmax > 0.1 ? 12 : 8) : Math.max(1, segs | 0)
  const g = new THREE.LatheGeometry(pts, n, opts.phiStart ?? 0, opts.phiLength ?? Math.PI * 2)
  if (rmax < 0.035) noInk(g)
  if (opts.wobble) wobble(g, opts.wobble, opts.seed ?? 1)
  return tally('lathe', place(paint(g, color), x, y, z, opts))
}

// ---------------------------------------------------------------------------
// sag + tube: see the header
// ---------------------------------------------------------------------------
const toV3 = (p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]))
class SagCurve extends THREE.Curve {
  constructor(a, b, amount) {
    super()
    this.a = toV3(a)
    this.b = toV3(b)
    this.amount = amount
  }
  getPoint(t, out = new THREE.Vector3()) {
    out.lerpVectors(this.a, this.b, t)
    out.y -= this.amount * 4 * t * (1 - t)
    return out
  }
}
export function sag(a, b, amount = 0.5) {
  return new SagCurve(a, b, amount)
}

export function tube(path, radius = 0.1, radialSegs = 6, color = '#FFFFFF', opts = {}) {
  const curve = path && typeof path.getPointAt === 'function' ? path : new THREE.CatmullRomCurve3(path.map(toV3), !!opts.closed, 'catmullrom', opts.tension ?? 0.5)
  const n = opts.segments || Math.max(3, Math.min(96, Math.round(curve.getLength() / (opts.step || 0.4))))
  const g = new THREE.TubeGeometry(curve, n, radius, Math.max(3, radialSegs | 0), !!opts.closed)
  const taper = opts.taper ?? 1
  if (taper !== 1) {
    const pos = g.attributes.position
    const ring = Math.max(3, radialSegs | 0) + 1
    const c = new THREE.Vector3()
    for (let i = 0; i <= n; i++) {
      const u = i / n
      curve.getPointAt(u, c)
      const k = 1 + (taper - 1) * u
      for (let j = 0; j < ring; j++) {
        const vi = i * ring + j
        pos.setXYZ(vi, c.x + (pos.getX(vi) - c.x) * k, c.y + (pos.getY(vi) - c.y) * k, c.z + (pos.getZ(vi) - c.z) * k)
      }
    }
    g.computeVertexNormals()
  }
  paint(g, color)
  if (radius < 0.03) noInk(g)
  tally('tube', g)
  if (!opts.caps || opts.closed) return g
  const a = curve.getPointAt(0)
  const b = curve.getPointAt(1)
  const capA = place(paint(new THREE.SphereGeometry(radius, Math.max(4, radialSegs), Math.max(3, radialSegs >> 1)), color), a.x, a.y, a.z)
  const capB = place(paint(new THREE.SphereGeometry(radius * taper, Math.max(4, radialSegs), Math.max(3, radialSegs >> 1)), color), b.x, b.y, b.z)
  return mergeAll([g, capA, capB])
}

// Sagging wire between two points (telephone lines).
export function wire(a, b, amount, color, radius = 0.022) {
  return tube(sag(a, b, amount), radius, 4, color, { segments: 12 })
}

// ---------------------------------------------------------------------------
// vary: painted mottling on existing vertex colours
// ---------------------------------------------------------------------------
export function vary(geo, amount = 0.06, seed = 1, freq = 0.35) {
  const col = geo.attributes.color
  if (!col) return geo
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const m = 1 + (fbm3(pos.getX(i) * freq, pos.getY(i) * freq, pos.getZ(i) * freq, seed, 2) - 0.5) * 2 * amount
    col.setXYZ(i, col.getX(i) * m, col.getY(i) * m, col.getZ(i) * m)
  }
  col.needsUpdate = true
  return geo
}



// ---------------------------------------------------------------------------
// SHEETS AND SLABS: the hand-made surfaces of the town
// ---------------------------------------------------------------------------
// a painted geometry straight from arrays (pos, optional index, per-vertex rgb)
function rawGeo(pos, idx, col, computeNormals = true) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  if (idx) g.setIndex(idx)
  if (computeNormals) g.computeVertexNormals()
  const n = pos.length / 3
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setAttribute('aLit', new THREE.BufferAttribute(new Float32Array(n), 1))
  return g
}

// noInk(geo): mark a piece as "no outline": the ink hull (outlineOf) skips its
// triangles. For surfaces whose outline is carried by their neighbours (tile
// sheets under their eave boards) and for accents too small to want a line.
// Halves the hull's cost where it adds nothing but noise.
export function noInk(geo) {
  const n = geo.attributes.position.count
  const a = new Float32Array(n)
  a.fill(1)
  geo.setAttribute('aNoInk', new THREE.BufferAttribute(a, 1))
  return geo
}

// wallBox: the body of a building: a box with every corner rounded and smooth
// normals, subdivided in height so the eave shade and the baked ground
// occlusion have vertices to grade through. r defaults to a hand-plastered 0.2.
export function wallBox(w, h, d, color, x, y, z, opts = {}) {
  const r = opts.r ?? Math.min(0.22, Math.min(w, h, d) * 0.12)
  return roundBox(w, h, d, r, opts.segs ?? 2, color, x, y, z, { ...opts, seg: opts.seg || [0, Math.max(3, Math.round(h / 1.4)), 0] })
}

// slab(nu, nv, fn, thickness, colorOf, opts): a thick curved sheet (cloth
// awnings, canopies, tarps, sails, tent skins). fn(i, j) -> [x, y, z] for the
// (nu + 1) x (nv + 1) grid of the TOP surface; the underside is the same
// surface pushed back along its smooth normals by `thickness`, and the rim is
// closed, so the ink hull wraps it as one soft shape and it reads from below.
// colorOf(i, j) -> hex per CELL (crisp stripes on a smooth surface);
// opts.under = brightness of the underside (0.8).
export function slab(nu, nv, fn, thickness = 0.04, colorOf = () => '#FFFFFF', opts = {}) {
  const W = nu + 1
  const P0 = new Float32Array(W * (nv + 1) * 3)
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const p = fn(i, j)
      P0.set(p, (j * W + i) * 3)
    }
  const idx = []
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * W + i
      idx.push(a, a + W, a + 1, a + 1, a + W, a + W + 1)
    }
  const t = new THREE.BufferGeometry()
  t.setAttribute('position', new THREE.BufferAttribute(P0, 3))
  t.setIndex(idx)
  t.computeVertexNormals()
  const N0 = t.attributes.normal.array
  // make sure "top" really is the side the normals point to (callers pass any
  // winding): flip so the first cell's normal faces opts.up (default +y)
  const up = opts.up || [0, 1, 0]
  let dot = 0
  for (let k = 0; k < N0.length; k += 3) dot += N0[k] * up[0] + N0[k + 1] * up[1] + N0[k + 2] * up[2]
  const sgn = dot < 0 ? -1 : 1
  t.dispose()
  const pos = []
  const nor = []
  const col = []
  const under = opts.under ?? 0.8
  const v = (k, bottom) => {
    const nx = N0[k * 3] * sgn
    const ny = N0[k * 3 + 1] * sgn
    const nz = N0[k * 3 + 2] * sgn
    if (bottom) return [P0[k * 3] - nx * thickness, P0[k * 3 + 1] - ny * thickness, P0[k * 3 + 2] - nz * thickness, -nx, -ny, -nz]
    return [P0[k * 3], P0[k * 3 + 1], P0[k * 3 + 2], nx, ny, nz]
  }
  const tri = (a, b, c, r, g, bl, flat) => {
    if (flat) {
      _e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      _e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2])
      _tn.crossVectors(_e1, _e2).normalize()
    }
    for (const q of [a, b, c]) {
      pos.push(q[0], q[1], q[2])
      if (flat) nor.push(_tn.x, _tn.y, _tn.z)
      else nor.push(q[3], q[4], q[5])
      col.push(r, g, bl)
    }
  }
  const quad = (a, b, c, d, r, g, bl, want) => {
    // orient the quad so its geometric normal agrees with `want` (a vertex normal or a direction)
    _e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    _e2.set(d[0] - a[0], d[1] - a[1], d[2] - a[2])
    _tn.crossVectors(_e1, _e2)
    const ok = _tn.x * want[0] + _tn.y * want[1] + _tn.z * want[2] >= 0
    const flat = want.length === 3 && want.flat
    if (ok) {
      tri(a, b, c, r, g, bl, flat)
      tri(a, c, d, r, g, bl, flat)
    } else {
      tri(a, c, b, r, g, bl, flat)
      tri(a, d, c, r, g, bl, flat)
    }
  }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      _c.set(colorOf(i, j))
      const k = [j * W + i, j * W + i + 1, (j + 1) * W + i + 1, (j + 1) * W + i]
      const T = k.map((q) => v(q, false))
      const B = k.map((q) => v(q, true))
      quad(T[0], T[1], T[2], T[3], _c.r, _c.g, _c.b, [T[0][3], T[0][4], T[0][5]])
      quad(B[0], B[1], B[2], B[3], _c.r * under, _c.g * under, _c.b * under, [B[0][3], B[0][4], B[0][5]])
      // rim
      const rim = (a, b, ox, oy, oz) => {
        const want = [ox, oy, oz]
        want.flat = true
        quad(T[a], T[b], B[b], B[a], _c.r * 0.9, _c.g * 0.9, _c.b * 0.9, want)
      }
      const cx = (T[0][0] + T[2][0]) / 2
      const cy = (T[0][1] + T[2][1]) / 2
      const cz = (T[0][2] + T[2][2]) / 2
      const out = (a, b) => [(T[a][0] + T[b][0]) / 2 - cx, (T[a][1] + T[b][1]) / 2 - cy, (T[a][2] + T[b][2]) / 2 - cz]
      if (j === 0) rim(0, 1, ...out(0, 1))
      if (j === nv - 1) rim(3, 2, ...out(3, 2))
      if (i === 0) rim(0, 3, ...out(0, 3))
      if (i === nu - 1) rim(1, 2, ...out(1, 2))
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setAttribute('aLit', new THREE.BufferAttribute(new Float32Array(pos.length / 3), 1))
  return tally('slab', g)
}

// tileSheet(w, L, opts): one slope of a terracotta roof. Local frame: the top
// edge (ridge) lies along x at z = 0, the slope runs out along +z, y is the
// slope normal; rotate it down by the pitch. Courses of tiles step over each
// other (opts.lip), the barrel tiles roll across (opts.amp every opts.roll),
// every course gets its own tone and a dark tucked edge, and the top edge
// dips in the middle (opts.dip) the way an old ridge sags.
// opts: { course 0.5, lip 0.055, roll 0.4, amp 0.035, color, seed, dip 0, tone 0.1 }
export function tileSheet(w, L, opts = {}) {
  const course = opts.course ?? 0.5
  const lip = opts.lip ?? 0.055
  const roll = opts.roll ?? 0.4
  const amp = opts.amp ?? 0.035
  const dip = opts.dip ?? 0
  const tone = opts.tone ?? 0.1
  const r = rng((opts.seed ?? 1) * 7919 + 13)
  _c.set(opts.color || '#C4673F')
  const cr = _c.r
  const cg = _c.g
  const cb = _c.b
  // four samples per roll: a narrow pan, then a round cover
  const PROF = [-1, 0.45, 1, 0.45]
  const TONE = [0.86, 1.0, 1.06, 1.0]
  const cols = Math.max(4, Math.round(w / roll) * 4)
  const rows = Math.max(1, Math.round(L / course))
  const pos = []
  const col = []
  const idx = []
  const colTone = []
  for (let i = 0; i <= cols; i++) colTone.push(1 + (r() - 0.5) * tone * 0.5)
  for (let j = 0; j < rows; j++) {
    const t0 = (j * L) / rows
    const t1 = ((j + 1) * L) / rows
    const k = 1 + (r() - 0.5) * tone * 2
    const base = pos.length / 3
    for (const [t, lift, shade] of [[t0, 0, 0.76], [t1, lip, 1.04]]) {
      for (let i = 0; i <= cols; i++) {
        const sx = i / cols
        const y = amp * PROF[i % 4] + lift - dip * 4 * sx * (1 - sx) * (1 - t / L)
        pos.push(-w / 2 + sx * w, y, t)
        const m = k * shade * colTone[i - (i % 4)] * TONE[i % 4]
        col.push(cr * m, cg * m, cb * m)
      }
    }
    const W = cols + 1
    for (let i = 0; i < cols; i++) {
      const a = base + i
      idx.push(a, a + W, a + 1, a + 1, a + W, a + W + 1)
    }
    // the riser under this course's lower edge (down to the next course, or the eave)
    const rb = pos.length / 3
    const drop = j === rows - 1 ? 0.1 : lip + 0.01
    for (let i = 0; i <= cols; i++) {
      const p = (base + W + i) * 3
      pos.push(pos[p], pos[p + 1], pos[p + 2], pos[p], pos[p + 1] - drop, pos[p + 2] - 0.012)
      for (let q = 0; q < 2; q++) col.push(cr * 0.62, cg * 0.58, cb * 0.56)
    }
    for (let i = 0; i < cols; i++) {
      const a = rb + i * 2
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
    }
  }
  return tally('tileSheet', noInk(rawGeo(pos, idx, col)))
}

// Smooth rounded blob for foliage / clouds: an icosphere fine enough that its
// silhouette is a curve, not a polygon (SPEC: never faceted nature).
export const blob = (r, color, x, y, z, opts) =>
  tally('blob', place(paint(new THREE.SphereGeometry(r, r < 0.16 ? 8 : 12, r < 0.16 ? 6 : 8), color), x, y, z, opts))

// Baked ambient occlusion in the vertex colours. Every vertex near the ground
// is darkened and warmed, so walls sit IN the street instead of on it; boxes
// only have corner vertices, so the falloff runs up the whole wall as a soft
// gradient for free. `heightAt(x, z)` is the terrain height.
export function bakeGroundAO(geo, heightAt, { reach = 1.6, floor = 0.74 } = {}) {
  const pos = geo.attributes.position
  const col = geo.attributes.color
  if (!pos || !col) return geo
  const p = pos.array
  const c = col.array
  for (let i = 0; i < pos.count; i++) {
    const h = p[i * 3 + 1] - heightAt(p[i * 3], p[i * 3 + 2])
    if (h >= reach || h < -0.6) continue
    const t = Math.max(0, h) / reach
    const k = floor + (1 - floor) * t * (2 - t)
    // warm the occlusion: blue falls fastest
    c[i * 3] *= k + (1 - k) * 0.22
    c[i * 3 + 1] *= k
    c[i * 3 + 2] *= k - (1 - k) * 0.12
  }
  col.needsUpdate = true
  return geo
}

// Darken a geometry's vertex colours between two heights (under an eave, a
// plinth line). Works on any painted geometry before the merge.
export function shadeBand(geo, y0, y1, k = 0.8) {
  const pos = geo.attributes.position
  const col = geo.attributes.color
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y < y0 || y > y1) continue
    col.setXYZ(i, col.getX(i) * (k + (1 - k) * 0.2), col.getY(i) * k, col.getZ(i) * (k - (1 - k) * 0.1))
  }
  return geo
}

export function mergeAll(list) {
  const flat = list.flat(Infinity).filter(Boolean)
  if (!flat.length) return null
  // Extrude/Icosahedron are non-indexed while Box/Cylinder/etc are indexed:
  // normalize so mergeGeometries always accepts the mix.
  const normalized = flat.map((g) => (g.index ? g.toNonIndexed() : g))
  // every piece carries the union of attributes (a neutral fill where missing)
  const need = new Map()
  for (const g of normalized) {
    for (const k in g.attributes) if (!need.has(k)) need.set(k, g.attributes[k].itemSize)
  }
  for (const g of normalized) {
    g.morphAttributes = {}
    for (const [k, size] of need) {
      if (g.attributes[k]) continue
      if (k === 'normal') {
        g.computeVertexNormals()
        continue
      }
      const arr = new Float32Array(g.attributes.position.count * size)
      if (k === 'color') arr.fill(1)
      g.setAttribute(k, new THREE.BufferAttribute(arr, size))
    }
  }
  const merged = mergeGeometries(normalized, false)
  flat.forEach((g) => g.dispose())
  normalized.forEach((g) => g.dispose())
  return merged
}

// Build the inverted-hull geometry for a merged mesh: positions only, weld,
// recompute smooth normals — so ink lines stay closed at hard box corners.
export function outlineOf(geo) {
  let g = new THREE.BufferGeometry()
  const src = geo.attributes.position
  const skip = geo.attributes.aNoInk
  if (skip && !geo.index) {
    // drop the triangles marked noInk()
    const keep = []
    for (let i = 0; i < src.count; i += 3) if (skip.getX(i) < 0.5) keep.push(i)
    const pos = new Float32Array(keep.length * 9)
    for (let k = 0; k < keep.length; k++) pos.set(src.array.subarray(keep[k] * 3, keep[k] * 3 + 9), k * 9)
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  } else {
    g.setAttribute('position', src.clone())
    if (geo.index) g.setIndex(geo.index.clone())
  }
  g = mergeVertices(g, 1e-4)
  g.computeVertexNormals()
  return g
}
