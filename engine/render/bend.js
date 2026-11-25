import * as THREE from 'three'
import { WORLD } from '../game/config.js'

// Shared uniforms so every material in the scene bends and sways identically.
export const bendUniforms = {
  uCurve: { value: WORLD.curve },
  uTime: { value: 0 },
  // 0 by day, 1 deep at night — Atmosphere drives it off the same clock as the
  // lights and the grade, so the windows come on exactly when the sun goes.
  uNight: { value: 0 },
  // warm window / lamp light (SPEC: #FFC27A)
  uLamp: { value: new THREE.Color('#FFC27A') },
  // Toon shading extras, shared by every cel material (Atmosphere drives them):
  //  uShadeTint  what the shadow side is multiplied by: WARM by day (a shadow on
  //              cream plaster goes clay, not grey), indigo at night
  //  uSunLum     luminance the key light delivers at full exposure, so the
  //              shader can tell "in shade" from "dimly lit" at any hour
  //  uRim        fresnel rim colour (already scaled by strength)
  uShadeTint: { value: new THREE.Color(1.05, 0.92, 0.87) },
  uSunLum: { value: 1.1 },
  uRim: { value: new THREE.Color(0.16, 0.13, 0.09) },
}

// Patch any built-in three material:
//  - world-bend: vertices curve down with distance from the camera
//    (Animal-Crossing-style rounded world; purely visual, physics stay flat)
//  - outline > 0: inverted-hull ink lines with a hand-drawn weight wobble
//  - wind > 0: gentle sway driven by uTime + world position (grass, foliage).
//    windLocal=true scales sway by the vertex's LOCAL height (grass blades
//    pinned at the root); otherwise the whole shape sways.
export function applyBend(material, { outline = 0, curved = true, wind = 0, windLocal = false, lit = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCurve = bendUniforms.uCurve
    shader.uniforms.uTime = bendUniforms.uTime
    shader.uniforms.uOutline = { value: outline }
    shader.uniforms.uWind = { value: wind }
    shader.uniforms.uNight = bendUniforms.uNight
    shader.uniforms.uLamp = bendUniforms.uLamp
    const toon = !!material.isMeshToonMaterial
    if (toon) {
      shader.uniforms.uShadeTint = bendUniforms.uShadeTint
      shader.uniforms.uSunLum = bendUniforms.uSunLum
      shader.uniforms.uRim = bendUniforms.uRim
    }

    let vs = shader.vertexShader

    if (outline > 0) {
      // Inverted-hull thickness is NOT constant any more. Two corrections, both
      // free (they ride the vertex shader that was already running):
      //
      //  1. DISTANCE. A fixed world-space offset projects to fewer and fewer
      //     pixels as it recedes, so far buildings used to lose their ink
      //     entirely and the horizon went mushy. Scaling the offset with camera
      //     distance keeps the line a roughly constant width ON SCREEN, which
      //     is how a pen behaves. Clamped at both ends: near geometry must not
      //     go hairline, far geometry must not balloon into a blob.
      //
      //  2. SILHOUETTE. A drawing puts weight on the outside edge and keeps
      //     interior creases light. dot(normal, viewDir) is ~0 exactly where
      //     the surface turns away from the eye — the silhouette — so weighting
      //     by that thickens the outline and thins everything facing us.
      //
      // NOTE: Under instancing the normal has to go through instanceMatrix too,
      // or every blade of instanced grass weights its outline off the wrong
      // orientation.
      vs = vs.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        float dwWob = 0.72 + 0.56 * sin(position.x * 41.0 + position.y * 29.0 + position.z * 53.0);

        vec4 dwOW = vec4(position, 1.0);
        vec3 dwNrm = normal;
        #ifdef USE_INSTANCING
          dwOW = instanceMatrix * dwOW;
          dwNrm = mat3(instanceMatrix) * dwNrm;
        #endif
        dwOW = modelMatrix * dwOW;

        float dwCam = distance(dwOW.xyz, cameraPosition);
        float dwWidth = clamp(dwCam * 0.075, 0.6, 3.0);

        vec3 dwWN = normalize(mat3(modelMatrix) * dwNrm);
        vec3 dwView = normalize(dwOW.xyz - cameraPosition);
        float dwSil = 1.0 - abs(dot(dwWN, dwView));

        transformed += normal * uOutline * dwWob * dwWidth * (0.5 + 0.9 * dwSil);`
      )
    }

    const windCode =
      wind > 0
        ? /* glsl */ `
        float dwH = ${windLocal ? 'clamp(position.y / 0.28, 0.0, 1.0)' : '1.0'};
        float dwSw = sin(uTime * 1.9 + dwWorld.x * 0.35 + dwWorld.z * 0.27);
        dwWorld.x += dwSw * uWind * dwH;
        dwWorld.z += cos(uTime * 1.4 + dwWorld.x * 0.31 + dwWorld.z * 0.22) * uWind * 0.6 * dwH;`
        : ''

    if (curved) {
      vs = vs.replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 dwWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          dwWorld = instanceMatrix * dwWorld;
        #endif
        dwWorld = modelMatrix * dwWorld;
        ${windCode}
        float dwDist = distance(dwWorld.xz, cameraPosition.xz);
        dwWorld.y -= dwDist * dwDist * uCurve;
        vec4 mvPosition = viewMatrix * dwWorld;
        gl_Position = projectionMatrix * mvPosition;`
      )
    }

    if (lit) {
      vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n        vLit = aLit;')
    }

    shader.vertexShader =
      'uniform float uCurve;\nuniform float uOutline;\nuniform float uTime;\nuniform float uWind;\n' +
      (lit ? 'attribute float aLit;\nvarying float vLit;\n' : '') +
      vs

    if (toon) {
      // warm shadow tone + fresnel rim, in one place for every cel surface
      shader.fragmentShader =
        'uniform vec3 uShadeTint;\nuniform float uSunLum;\nuniform vec3 uRim;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          /* glsl */ `
          {
            float dwDir = dot(reflectedLight.directDiffuse, vec3(0.299, 0.587, 0.114));
            float dwAlb = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) + 0.02;
            float dwLitK = clamp(dwDir * 3.14159 / (dwAlb * uSunLum), 0.0, 1.0);
            outgoingLight *= mix(uShadeTint, vec3(1.0), smoothstep(0.55, 0.95, dwLitK));
            float dwFres = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
            outgoingLight += uRim * diffuseColor.rgb * dwFres * dwFres * dwFres * (0.35 + 0.65 * dwLitK);
          }
          #include <opaque_fragment>`
        )
    }

    if (lit) {
      // Emission goes in just before tonemapping, so lit windows bloom through
      // the composer like any other bright pixel instead of being clamped flat.
      shader.fragmentShader =
        'uniform float uNight;\nuniform vec3 uLamp;\nvarying float vLit;\n' +
        shader.fragmentShader.replace(
          '#include <tonemapping_fragment>',
          /* glsl */ `
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uLamp * (0.75 + 0.6 * vLit), step(0.01, vLit) * smoothstep(0.25, 0.8, uNight) * (0.55 + 0.45 * vLit));
          #include <tonemapping_fragment>`
        )
    }
  }
  // NOTE: the cache key MUST include every branch above, or two materials with
  // different options silently share the first one's compiled program.
  material.customProgramCacheKey = () =>
    `dw2-${material.type}-${curved ? 'c' : 'f'}-${outline > 0 ? 'o' : 's'}-${wind > 0 ? (windLocal ? 'wl' : 'w') : 'n'}-${lit ? 'l' : 'x'}`
  return material
}
