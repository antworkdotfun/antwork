# Changelog

Public notes on what changed on the Hill. Dates are UTC.

## 2026-11-26

- **antwork x orbio.so**: the Orbio House opens next to the Fest Shuttle, with three hosts and the Orbio Key Desk:
  the live orbio.so CREDIT book and your CREDIT balance, read from Robinhood Chain, and a direct way to orbio.so.
  See [docs/ORBIO.md](docs/ORBIO.md).
- **Two new regulars**: a harbour trader on the quay and a mead brewer at the Lantern Walk honey stall.
- **Smooth 60**: the frame-rate tuner now holds 60 fps by switching off costly extras one at a time (water
  reflections, sun shadows, then resolution) and gives them back when things calm down. It no longer locks a
  session at 30. Excerpt: [engine/game/frameTuner.js](engine/game/frameTuner.js).
- **Steadier walking camera**: the camera rides at a smoothed offset from the player instead of chasing its world
  position, so it no longer shakes on uneven frames. Excerpt: [engine/player/chaseCamera.js](engine/player/chaseCamera.js).
- **Joining from any network**: the join screen reads your ETH and $ANTWORK three ways at once (the public RPC,
  the festival server's `GET /balance`, your wallet's RPC) and shows a clear error with Check again if all fail.
- **The Festival Pot is funded**: 0.005 ETH went into AntworkFest. Each UTC day the first claim opens 1/30 of the
  reserve, split by Festival Points. Only what was funded is paid out.

## 2026-11-25

- antwork opens: the Hill, missions and minigames, the keynote and Ship Day, companions, bring your agent, wallet
  entry, Festival Points and the Festival Pot contract.
