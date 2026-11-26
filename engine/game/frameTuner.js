// engine/game/frameTuner.js: EXCERPT from the antwork client (src/game/gfx.js): the frame-rate tuner.
// Reads `state`, `relief`, `cap`, `emit`, `store` and the presets from the rest of gfx.js (not published here).
//
// FRAME RATE + QUALITY POLICY (2026-11-26): a steady, smooth 60.
//   SMOOTHNESS FIRST. The old policy dropped to a steady 30 fps cap whenever 60 wobbled and never came
//   back in the session, which looked choppy (a live stream, a wallet popup or
//   a shader compile was enough to lock a session at 30).
//   * Every session starts at the device's DEFAULT preset at full DPR. The tuner's own steps are never
//     saved; only a preset the player picks in Options persists (Auto off).
//   * Auto holds 60 by shedding costly extras one at a time: 1 water reflections off, 2 sun shadows off,
//     3 DPR x0.85, 4 DPR x0.72, and on phones 5 one preset down. Anti-aliasing and the painted grade are
//     never switched off by the tuner.
//   * When 60 is solid again for a while, it gives one step back (and waits longer each time it had to
//     shed again, so it never seesaws).
//   * It never drops to 30 on its own: the 30 cap exists only when the player picks it in Options.
//   * It never climbs past the device default on its own (ULTRA is a choice).

// ---- the tuner: hold 60 by shedding extras, give them back when 60 is solid ------------
// Samples window.__dwStats.fps (frames actually DRAWN per second, published by the render loop every
// 500ms) while in town.
let samples = []
let settleUntil = 0
let goodSince = 0 // when 60 last became solid (ms)
let backoff = 20000 // how long 60 must stay solid before one step is given back; doubles after each re-shed
function resetTuner() {
  samples = []
  settleUntil = Date.now() + 7000
  goodSince = 0
}
function settle(ms) {
  settleUntil = Date.now() + ms
  samples = []
  goodSince = 0
}

function tuneTick() {
  if (typeof window === 'undefined' || forced) return
  if (document.hidden) return // worker-pumped fps is not real fps
  if (store.state.screen !== 'game') {
    samples = []
    goodSince = 0
    return
  }
  const fps = window.__dwStats?.fps
  if (!fps) return
  if (Date.now() < settleUntil) return // shaders compile, targets reallocate: let it warm up
  samples.push(fps)
  if (samples.length > 4) samples.shift()
  if (samples.length < 3) return
  const mid = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  const mode = fpsForced || state.fpsMode
  if (mode !== 'auto' || !state.auto) return // the player chose a cap or a preset: hands off
  if (cap !== 60) {
    cap = 60 // an older session's auto-30 never survives into this policy
    emit()
  }

  const DROP = isMobile ? 50 : 54
  if (mid < DROP) {
    // shed one extra and look again in a few seconds
    const max = isMobile && ORDER.indexOf(state.preset) > 0 ? 5 : 4
    if (relief < max) {
      relief++
      if (relief === 5) {
        // phones only, the very last resort: one preset down, at full DPR
        state.preset = ORDER[ORDER.indexOf(state.preset) - 1]
        state.overrides = {}
        relief = 0
      }
      if (goodSince === -1) backoff = Math.min(backoff * 2, 5 * 60000)
      emit()
      settle(6000)
    }
    return
  }
  // 60 is holding: after a solid stretch, give one step back
  if (relief > 0 && mid >= 58) {
    if (!goodSince || goodSince === -1) goodSince = Date.now()
    else if (Date.now() - goodSince > backoff) {
      relief--
      emit()
      settle(6000)
      goodSince = -1 // remember we just climbed: shedding right after this doubles the wait
    }
  } else if (goodSince !== -1) goodSince = 0
}

