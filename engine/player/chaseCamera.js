// engine/player/chaseCamera.js: EXCERPT from the antwork client (src/player/Player.jsx): the walking camera.
// Inside the player's per-frame update; `st` is the player state, `_target` / `_desired` / `_camOff` / `_offWant`
// are THREE.Vector3 scratch vectors, `snappedIn` comes from the wall raycast above it (not published here).

// 1) the follow height
      // the camera follows a smoothed height, not the raw one: bumps in the ground (and the ground ease itself) would
      // otherwise ride straight into the frame as a vertical shake. Jumps get a quicker rate so the view keeps up.
      if (st.camBaseY == null || !st.camOffReady) st.camBaseY = st.pos.y
      st.camBaseY += (st.pos.y - st.camBaseY) * (1 - Math.exp(-(st.airborne ? 9 : 5) * dt))
      _target.set(st.pos.x, st.camBaseY + (st.sitting ? 0.8 : 1.25), st.pos.z)

// 2) the rigid chase: a smoothed OFFSET, never a smoothed world position
    // Rigid chase: the camera sits at the follow target plus a SMOOTHED OFFSET. Smoothing the world position instead
    // (the old camera.position.lerp) trails a walking player by speed/14 metres, and that trail stretches and shrinks
    // with every uneven frame: the whole picture shook while walking. Orbit, zoom and wall pull-in still ease.
    // A wall sliding in must not be eased through, so it snaps and eases out later.
    _offWant.subVectors(_desired, _target)
    if (!st.camOffReady) {
      _camOff.subVectors(camera.position, _target)
      st.camOffReady = true
    }
    if (snappedIn) _camOff.copy(_offWant)
    else _camOff.lerp(_offWant, 1 - Math.exp(-14 * dt))
    camera.position.copy(_target).add(_camOff)
    camera.lookAt(_target)
