import * as THREE from 'three'
import { applyBend } from './bend.js'
import { P, WORLD } from '../game/config.js'

// Soft 3-tone cel ramp: shadow / half-tone / lit, with narrow smooth edges so
// the bands read as brushed rather than aliased. The shadow TONE comes from
// here; its warm COLOUR comes from uShadeTint in bend.js.
let _grad = null
export function gradientMap() {
  if (!_grad) {
    const N = 64
    const data = new Uint8Array(N)
    const ss = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1)
      const v = 0.6 + 0.2 * ss(0.2, 0.27, x) + 0.2 * ss(0.5, 0.58, x)
      data[i] = Math.round(v * 255)
    }
    _grad = new THREE.DataTexture(data, N, 1, THREE.RedFormat)
    _grad.minFilter = THREE.LinearFilter
    _grad.magFilter = THREE.LinearFilter
    _grad.needsUpdate = true
  }
  return _grad
}

// Cel-shaded fill material (world-bent).
export function toonMat(opts = {}, bendOpts) {
  const m = new THREE.MeshToonMaterial({ gradientMap: gradientMap(), ...opts })
  return applyBend(m, bendOpts)
}

// Unlit flat material (world-bent unless told otherwise).
export function flatMat(opts = {}, bendOpts) {
  return applyBend(new THREE.MeshBasicMaterial(opts), bendOpts)
}

// Inverted-hull ink line material: backfaces pushed out along smooth normals.
export function inkMat(thickness = WORLD.outline, { curved = true, wind = 0, windLocal = false } = {}) {
  const m = new THREE.MeshBasicMaterial({ color: P.ink, side: THREE.BackSide })
  return applyBend(m, { outline: thickness, curved, wind, windLocal })
}
