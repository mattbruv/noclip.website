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

Hover height comes from `TrkInfo_GetTerrainInfoFunc` at init time, so like the other actors
it is scraped from a memory dump rather than reverse engineered — see
[tools/actorTransforms.ts](tools/actorTransforms.ts) above.

The gem is drawn darker here than the game draws it, and that is a choice rather than a
finding. `PU_INNER` is one untinted batch sampling texture 2108, whose gem patches are
`#CA2221` flat, with no vertex colors to modulate them — so the bright red is exactly what
the disc ships. `POWERUP_INNER_TINT` in [Scenes.ts](Scenes.ts) multiplies it down by about
a half, pulling the red channel hardest so it cools as it darkens; set it to `WHITE_TINT`
to get the authored look back, or scale it further towards zero for near-black. Nothing
else in the scene is tinted, and the shell, ribbon and sparkles are left alone.

The one thing not read out of the machine code is the order `mat44flt_EulerAngles`
composes its three rotations in — that is inside the VU0 macro ops, and the renderer
assumes Y, then X, then Z.

`Glow.ts` implements the shared glow system (`ColGlow_CreateRing` /
`ColGlow_CreateStarSmooth` shapes, and the `_$GlowStart` microprogram's billboard
expansion), so the other effects built on it — sun flares, light glows, lightning, the
pickup flash — can reuse it.

## Collision (the track `gmd ` resource)

`TrkInfo_ParseTrack` walks the track's `gmd ` resource as a flat list of tagged records,
each with a 0x10 byte header: `Trck`, `GrLi`, `Ligh`, `SunI`, `Visi`, `Curv`, `GrIn`,
`GrVx`, `GrPi`, `GrFi`. The three that make up the collision mesh are parsed by
[asset/gmd.ts](asset/gmd.ts):

| Record | Stride | Contents |
| ------ | ------ | -------- |
| `GrVx` | 0x10 | Vertex positions, one qword each |
| `GrPi` | 0x10 | Polygons: four u16 vertex indices, then surface flags at `+0xe` |
| `GrFi` | 0x08 | Fences: two u16 vertex indices plus flags |

Every count lives together at the top of `GrIn`, which is also the lookup grid:
`TrkInfo_GetGridInfo` reads its dimensions from `+0x00`/`+0x02` and its origin from
`+0x10`, and derives a cell index straight from the world position, so a cell is one world
unit square.

Polygons are quads, and a triangle just repeats a vertex — `TrkInfo_IsPointOverTrackPoly`
reads all four indices unconditionally. **Bit 0 of the surface flags is what makes a
polygon drivable**: both `TrkInfo_GetTerrainInfoFunc` and `TrkInfo_GetFloorElevationFunc`
skip a polygon outright when it is set. Around 71-100% of each track's polygons are
drivable by that test, and the flag field carries plenty more bits (surface material,
presumably) that are not decoded yet.

The Collision panel has a toggle per layer, all off by default.

The collision mesh is coplanar with the visible track — sampled against the rendered track
triangles along the racing line, the two agree to within about a world unit, median zero —
so drawing it needs a way past the resulting z-fight. The debug layers are depth-tested
like everything else and nudged 60 scene units towards the camera in the vertex shader,
which clears the surface underneath while staying far too small to punch through terrain or
buildings. Hills, trees and walls occlude them properly.

## Lights (the track `gmd ` resource)

The nine tracks that race in daylight ship no `Ligh` record at all. On the six
that do not, it holds **two unrelated light arrays back to back**, split by a
pair of counts in its own header — `+0x08` is how many are in the first group,
`+0x0C` the second, and the payload is exactly `(a + b) * 0x20` bytes.
`TrkInfo_ParseTrack` slices it accordingly, then hands every `Trck` section a
run out of each: a pointer at section `+0x0C` with a count at `+0x39` for the
first group, `+0x1C` and `+0x3A` for the second. (`Trck+0x10` is the number of
sections, not of lights, and the record carries a second 0x40-byte array after
it whose count is at `+0x11`, which none of this touches.)

**Group A are the glow billboards** — the flares on the light poles.
`TrkInfo_DrawLightGlows` copies each one straight into the `ColGlow` list that
[Glow.ts](Glow.ts) already implements, so they render through the same path the
power-up sparkle does:

| Offset | Contents |
| ------ | -------- |
| `+0x00` | position; `+0x0C` doubles as its `w` and as the glow radius |
| `+0x10` | inner color, RGBA8, alpha `0x80` (opaque on the GS scale) |
| `+0x14` | outer color, the same hue at alpha `0x00` |
| `+0x18` | shape byte |
| `+0x1C` | zero in the file; the light-trail slot after load |

The shape byte is queued as `light[0x18] + 0x80`, and that top bit is what
switches `ColGlow_RenderAllGlowInCurrentList` out of its ordinary one-shape path
and into a composite of up to three, each sized off the radius: bits 0-1 a
filled disc out to `0.5 * r` per step, bits 2-4 a star whose value *is* its
point count (`Star1` through `Star4`) running solid to `r` and fading out by
`1.5 * r`, and bits 5-6 a thin ring straddling `0.4 * r` per step. Every
descriptor in the game decodes
inside those field widths, which is the check that the split is right: 831
lights are a disc plus a three-point star, and the rest are discs, discs with a
halo, or one four-point variant on Touch And Go. Colors are per-track — amber
street lights on the two Metropolis courses, red and blue down The Gauntlet,
magenta on Wild Kingdom, white under Falls Down.

A star is **two** strips per bow-tie, not one, and `ColGlow_StartGlowStrip`
allocates `points * 0xe` vertices to say so: ten for the five point pairs of the
outline, then four more that are all class A, walked tip, waist, waist, tip so
the two triangles between them fill the bow-tie in. Miss that second strip and
every triangle left has one vertex at the waist and two along the same spike, so
the shape collapses to a sliver and rasterizes as a pair of thin edges — spikes
drawn as outlines. The power-up flare never shows this, because its star sets
`colorA` to `0x00000000` and the body it fills with is transparent; the track
lights put an opaque color there, so on them it is the whole effect.

**Group B are point lights**, and nothing about them is directly visible: they
shade the cars. `GrLi` is their spatial hash — grid dimensions at `+0x08`, X/Z
origin at `+0x10`, then one `s32` head index per cell, with each light's `+0x1C`
chaining to the next in the same cell. Both get fixed up to pointers at load.
`TrkInfo_ComputeLightingEnvironment` derives the cell at **8 world units** a
side, walks a 2x2 neighbourhood, and keeps the two strongest, where strength is
`radius / distance - 1` clamped to 2 and dropped at zero. The Lights panel draws
them as a ring at the radius each one reaches, off by default; the authored
colors run from a near-black blue fill up to warm white, so the debug rings are
normalized to stay readable.

Two things the game does that this does not. It only queues a light once the
section holding it passes the `Visi` test and stops at 160 glows in the list,
where this draws every light in the track every frame — which costs nothing
measurable even on Car Go, the heaviest at 407 lights and 814 shapes. And it
picks its ring between `Ring10` and `Ring32` by view distance, purely to keep
VU1 fed; every ring here gets the nearest LOD.

The light trails are **not** reproduced. `TrkInfo_GetLightTrails` gives every
group-A light a slot in `ULightTrail.c`'s pool — a 20-entry ring of transformed
positions covering the last 0.15 seconds, 0.07 wide, fading out over an alpha
ramp capped at 0.3, in a fixed warm white `(0.95, 0.95, 0.75)` that ignores the
light's own color. What `LT_vRenderLightTrail` is not clear about is the space
it works in: it offsets `x`/`y` by a constant before anything divides by `w`,
and gates on a `z` between 0 and 10, which is neither view space nor clip space
as written. Guessing would produce a streak that looks wrong rather than one
that is missing.

## Paths (the `Cnet` resources)

Every track carries a handful of `Cnet` resources, parsed by [asset/cnet.ts](asset/cnet.ts).
`Network_DownloadData` registers the network at resource `+0xC`, where a `u16` id is
followed by an `s16` point count and then the points, 0x20 bytes each:

| Offset | Contents |
| ------ | -------- |
| `+0x04` | position; a Y of 0 is resolved against the terrain at load, like actors |
| `+0x10` | radius — how wide the path is at this point |
| `+0x14` | two `s16` connection slots, -1 when empty |
| `+0x18` | flags (16 distinct values on a racing line, 1 elsewhere) |
| `+0x1a` | speed hint, in steps of five; only the racing line uses it |

`Network_FindValidConnectingPoint` walks both connection slots, so these are graphs, not
polylines — which is exactly what makes the racing line interesting: the second slot is
where the AI's alternate lanes and shortcuts live (41 of SE1's 425 points have one).

The resource name is the only thing that says what a network is *for*, since several kinds
share an id: `NET.TXT` is the line the AI cars drive, `MAP` is the outline the track map is
drawn from, and the rest are named after whatever follows them — `DUSTER`, `CHOPPER`,
`TRAINS`, `FISH`, `HAWK`, `GULL`, `JETSKI`, `UFO`, `PTERASAUR`, `TWISTER`, `RATS`,
`DOCKCRANES`. The Paths panel has a toggle per network, off by default, drawn as edges plus
nodes in a colour per path.

Actors travel these paths. An actor's resource list — the `aRSL` chunk — is a run of
(fourCC, resource index) pairs, and an actor that moves has a `Cnet` entry among them; that
is the binding `Network_InitNetActor` follows, and it is why a helicopter's body and its
blades both name the same path. The base speed `Network_InitNetActor` copies into the
movement state comes from the actor header at `+0x28`, which is how a dock crane (15) ends
up slower than a crop duster (200).

Each actor joins its path at the point it spawned nearest to, as `Network_FindNearestPoint`
does, and then follows the first valid connection out of each point, like
`Network_FindValidConnectingPoint`. Sharing a path therefore staggers actors rather than
stacking them.

Three things are deliberately not reproduced. The absolute speed scale is calibrated by eye
(`NETWORK_SPEED_SCALE`), because the units those speed values feed into inside
`moveNetworkObject` are not pinned down — relative speeds between actors are the data's own.
The actor faces its direction of travel with yaw only, where the game also banks and
pitches. And where a path branches, this follows the first connection every lap instead of
choosing, and closes the route back on itself to keep moving.

## Future Improvements / Cool Ideas
- Render the Sun/Moon/stars
- Pin down the space `LT_vRenderLightTrail` works in and draw the light trails
- Reproduce the real network movement model in `moveNetworkObject` (banking, pitch, branch selection, and the speed units) rather than the constant-speed traversal used now
