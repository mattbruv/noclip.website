## TS Port

The Rumble Racing TypeScript parsing code was ported by Claude Sonnet 4.6 in a single prompt from my original Go codebase at https://github.com/mattbruv/rumble-racing-re.

Any additional reverse engineering work will happen upstream in that repository before finding its way to noclip.

## Actor Transformation Note

Because there was too much logic to reverse engineer to place actors correctly, I have pre-processed the transformations for the individual actors in the scenes.
I took a save state using PCSX2 at the exact moment after loading the level and scraped out the final actor Y levels and transformations using [this script](https://github.com/mattbruv/rumble-racing-re/blob/main/scripts/searchY.py).
This pre-processed JSON data should be served alongside the game's data in the DATA folder for actors to be placed properly.

[tools/actorTransforms.ts](tools/actorTransforms.ts) does the same job from inside this
repo and fills in what `searchY.py` could not. It runs three passes over each dump:
power-ups (which `searchY.py` skips, since it bails on actors with no
`O3DResourceIndex`), then an exact float-bit match on X/Z for anything still unplaced,
then a tolerant match (within 0.01) restricted to candidates that sit inside a live actor
struct — a code pointer at `actor+0xAC` — which is what recovers the glass barricades,
whose coordinates the game rewrites slightly. It never overwrites an existing entry, so it
is safe to re-run over JSON that `searchY.py` produced, and where both methods resolve the
same actor they agreed on all 669 cases tested.

That leaves 51 actors across the 15 tracks with no runtime transform at all, because the
capture simply does not contain them: one easter egg per track, the stopwatch pickups on
the three Daytona tracks, and The Gauntlet's car wrecks. They are not scrape failures —
nothing spawns them in a savestate taken at the start line. The scene falls back to the
position the track file authored for those, which is usually deliberate (the wrecks carry
authored Y values), but leaves their basis unknown, so they render axis-aligned. The
authored rotation is not in the `Cact` chunk in any form I could find — neither a yaw
angle nor a stored basis survives a search against actors whose runtime rotation is
known — so it is computed at init from something else.

## Power-Ups

The on-track pickups are `Cact` actors of type 8, which the track file leaves without an
`O3DResourceIndex` and with `Y` set to 0. Both come from code instead:

- `powerUp_Init` loads **two** models out of `GLBLDATA.TRK`: `PU_INNER.O3D` (5011) as the
  actor's own object, and `PU_OUTER.O3D` (5012) as a second `Object3D` at `actor+0x110`.
  `powerUp_Simulate` spins the inner one a quarter turn per second about the vertical
  axis, and tumbles the shell on three separately accumulating angles — 72, 108 and 839
  deg/sec, fed to `mat44flt_EulerAngles` as its Y, X and Z arguments. The render command
  queues the shell itself and then falls through to `ActBase_BasicExeCmd` for the inner
  model.
- `SFX_RenderPowerup` appends three definitions to the engine-wide `ColGlow` billboard
  list every frame: two rings (`0 -> r` and `1.1r -> r`, `#A8A8FF` at alpha `0x60`) and a
  star flare (`3r -> 0`, `#B8B8FF` at alpha `0x80`, rotated a quarter turn). Both hang off
  the inner model's bounding-sphere center, and `SFX_InitPowerup` sets
  `r = 0.9 * max(inner, shell)` bounding radius when a shell is present.

Note that the **Feb 7 debug build does not have `PU_OUTER` at all** — its 5011 is
`DIAMOND.O3D`, twice the size of the final `PU_INNER`, and `SFX_InitPowerup` falls back to
`r = inner radius` there. Anything about the pickups read out of that build describes an
older, shell-less version of the effect: the final pickup is a red gem with a gold ribbon
and two sparkles tumbling around it, inside the glow. The constants above were re-read
from the final build (`SFX_RenderPowerup` at `0x135B70`, `powerUp_Init` at `0x1808E0`,
`powerUp_Simulate` at `0x1812A0`, `SFX_InitPowerup` at `0x135D20`), where every glow
definition also sets a byte at `+0x26` that the debug build leaves alone.

The one thing not read out of the machine code is the order `mat44flt_EulerAngles`
composes its three rotations in — that is inside the VU0 macro ops, and the renderer
assumes Y, then X, then Z.
- Hover height comes from `TrkInfo_GetTerrainInfoFunc` at init time, so like the other
  actors it is scraped from a memory dump rather than reverse engineered:
  [tools/powerupTransforms.ts](tools/powerupTransforms.ts) matches each pickup's X/Z
  against PCSX2's `eeMemory.bin` and merges the resulting positions into the per-track
  JSON. Re-run it after regenerating that JSON with `searchY.py`, which skips actors
  without a model resource and therefore skips every power-up.

`Glow.ts` implements the shared glow system (`ColGlow_CreateRing` /
`ColGlow_CreateStarSmooth` shapes, and the `_$GlowStart` microprogram's billboard
expansion), so the other effects built on it — sun flares, light glows, lightning, the
pickup flash — can reuse it.

## Future Improvements / Cool Ideas

- Add a render toggle for showing driveable polygons and/or collision geometry
- Render the Sun/Moon/stars
- Place instanced "lights" (the star effect/texture on light poles)
- Would be cool to animate networked actor and move them along their spline paths (Cropduster/Helicopters/Planes/Tornado)
