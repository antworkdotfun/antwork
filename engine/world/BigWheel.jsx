import * as THREE from 'three'
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { getCity } from './town.js'
import { P } from '../game/config.js'
import { box, cyl, ball, paint, place, mergeAll, outlineOf, lathe, tube } from './geo.js'
import { toonMat, inkMat } from '../render/toon.js'

// ============================================================================
// The Big Wheel's moving parts (the frame and boarding deck are static, in
// districts/dock.js). Four draw calls: the wheel + its ink line, and ten
// gondolas + their ink line as instanced meshes that stay upright while the
// wheel turns. Rim lamps are painted in the lamp colour, so they switch on at
// dusk through the same uNight uniform as every window in town.
// ============================================================================

const GONDOLAS = 10
const PERIOD = 96 // seconds per revolution

function wheelGeo(r) {
  const g = []
  for (const sz of [-0.85, 0.85]) {
    g.push(place(paint(new THREE.TorusGeometry(r, 0.09, 6, 48), P.cream), 0, 0, sz))
    g.push(place(paint(new THREE.TorusGeometry(r * 0.55, 0.06, 6, 36), P.coral), 0, 0, sz))
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2
      g.push(cyl(0.035, 0.035, r - 0.4, 5, i % 2 ? P.cream : P.coral, Math.cos(a) * (r + 0.4) * 0.5, Math.sin(a) * (r + 0.4) * 0.5, sz, { rz: a - Math.PI / 2 }))
    }
    g.push(cyl(0.75, 0.75, 0.12, 20, P.coral, 0, 0, sz * 1.08, { rx: Math.PI / 2 }))
    g.push(cyl(0.36, 0.36, 0.16, 16, P.night, 0, 0, sz * 1.12, { rx: Math.PI / 2 }))
    // rim lamps
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2
      g.push(place(paint(new THREE.SphereGeometry(0.09, 6, 4), '#FFE2A8'), Math.cos(a) * r, Math.sin(a) * r, sz * 1.14))
    }
  }
  // cross bars the gondolas hang from
  for (let i = 0; i < GONDOLAS; i++) {
    const a = (i / GONDOLAS) * Math.PI * 2
    g.push(cyl(0.05, 0.05, 1.9, 6, '#5F5146', Math.cos(a) * r, Math.sin(a) * r, 0, { rx: Math.PI / 2 }))
  }
  return mergeAll(g)
}

function gondolaGeo() {
  const g = []
  // origin = the pivot bar; the cabin hangs below it. A round tub with a
  // rolled rim and a soft belly under a striped parasol roof.
  g.push(tube([[0, 0, -0.5], [0, -0.3, -0.56], [0, -0.42, -0.5]], 0.03, 5, '#5F5146', { segments: 4 }), tube([[0, 0, 0.5], [0, -0.3, 0.56], [0, -0.42, 0.5]], 0.03, 5, '#5F5146', { segments: 4 }))
  const roof = []
  for (let i = 0; i < 8; i++) roof.push(lathe([[0.04, 0.02], [0.3, -0.03], [0.58, -0.14], [0.8, -0.3], [0.82, -0.4]], 2, i % 2 ? P.cream : P.coral, 0, 0, 0, { phiStart: (i / 8) * Math.PI * 2, phiLength: Math.PI / 4 + 0.001 }))
  g.push(place(mergeAll(roof), 0, -0.2, 0))
  g.push(lathe([[0.8, -0.4], [0.6, -0.26], [0.3, -0.15], [0.02, -0.1]], 16, '#B85C3E', 0, -0.22, 0))
  g.push(lathe([[0, 0], [0.05, 0.02], [0.06, 0.08], [0, 0.12]], 8, P.coral, 0, -0.2, 0))
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    g.push(cyl(0.025, 0.025, 0.8, 5, '#5F5146', Math.cos(a) * 0.6, -0.98, Math.sin(a) * 0.6))
  }
  g.push(lathe([[0, -0.6], [0.36, -0.58], [0.56, -0.48], [0.66, -0.26], [0.7, 0], [0.74, 0.03], [0.74, 0.09], [0.66, 0.1], [0.62, 0], [0.5, -0.4], [0, -0.46]], 16, P.coral, 0, -1.34, 0))
  g.push(lathe([[0.675, -0.2], [0.705, -0.06], [0.69, -0.04]], 16, P.cream, 0, -1.34, 0))
  g.push(ball(0.09, '#FFE2A8', 0, -1.98, 0))
  return mergeAll(g)
}

export function BigWheel() {
  const set = useMemo(() => (getCity().sets || []).find((s) => s.kind === 'wheel'), [])
  const wheel = useRef()
  const gond = useRef()
  const gondInk = useRef()
  const { wg, wo, gg, go, mats } = useMemo(() => {
    if (!set) return {}
    const wg = wheelGeo(set.r)
    const gg = gondolaGeo()
    return {
      wg,
      wo: outlineOf(wg),
      gg,
      go: outlineOf(gg),
      mats: {
        fill: toonMat({ vertexColors: true }, { lit: true }),
        ink: inkMat(0.03),
      },
    }
  }, [set])
  const m4 = useMemo(() => new THREE.Matrix4(), [])

  useFrame(({ clock }) => {
    if (!set || !wheel.current) return
    const a0 = (clock.elapsedTime / PERIOD) * Math.PI * 2
    wheel.current.rotation.z = a0
    for (let i = 0; i < GONDOLAS; i++) {
      const a = a0 + (i / GONDOLAS) * Math.PI * 2
      m4.makeRotationZ(Math.sin(clock.elapsedTime * 0.7 + i) * 0.035)
      m4.setPosition(set.x + Math.cos(a) * set.r, set.y + Math.sin(a) * set.r, set.z)
      gond.current.setMatrixAt(i, m4)
      gondInk.current.setMatrixAt(i, m4)
    }
    gond.current.instanceMatrix.needsUpdate = true
    gondInk.current.instanceMatrix.needsUpdate = true
  })

  if (!set) return null
  return (
    <group>
      <group ref={wheel} position={[set.x, set.y, set.z]}>
        <mesh geometry={wg} material={mats.fill} />
        <mesh geometry={wo} material={mats.ink} />
      </group>
      <instancedMesh ref={gond} args={[gg, mats.fill, GONDOLAS]} frustumCulled={false} />
      <instancedMesh ref={gondInk} args={[go, mats.ink, GONDOLAS]} frustumCulled={false} />
    </group>
  )
}
