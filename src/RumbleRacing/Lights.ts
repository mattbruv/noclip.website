import { vec3 } from "gl-matrix";
import { colorNewFromRGBA } from "../Color";
import { GlowDef, GlowShape, glowColorFromRGBA32 } from "./Glow";
import { GlowLight, PointLight, TrackLights } from "./asset/gmd";

// The lights in a track's `gmd ` resource. TrkInfo_DrawLightGlows walks the
// glow group of every visible track section and appends each light to the
// ColGlow billboard list, with the shape byte the file authored plus 0x80:
//
//   lbu   t0,0x18(a3)        ; the light's shape byte
//   addiu t5,t0,0x80         ; ...with the composite bit set
//   sb    t5,0x25(t1)
//
// That top bit is what switches ColGlow_RenderAllGlowInCurrentList out of its
// ordinary one-shape path and into the composite below, where the remaining
// bits each drive one shape sized off the light's radius. Everything else about
// the definition — center, both colors, a zero angle — is copied straight
// across, which is why these go through the same GlowRenderer the power-up
// sparkle does.

// The filled disc at the middle spans nothing to half the radius, once per
// step of the core field:
//
//   mul.S f1,f0,f1           ; radius * core
//   mul.S f0,f0,f1           ; * 0.5
//   sw    zero,0x34(s3)      ; radiusA = 0
const CORE_SCALE = 0.5;

// The star flare always spans the radius itself out to half again, and takes
// its point count from the star field rather than its size.
const STAR_OUTER_SCALE = 1.5;

// The halo is a pair of rings that straddle 0.4 of the radius per step, drawn
// with the same radiusA so each one is a thin band rather than a filled disc.
const HALO_SCALE = 0.4;
const HALO_HALF_WIDTH = 0.015625;

// The game picks its ring between Ring10 and Ring32 by view-space distance,
// purely to keep VU1 fed; the shapes are otherwise identical. Nothing here is
// bound the way the console was, so every ring gets the nearest LOD.
const RING_SHAPE = GlowShape.Ring32;

// Point lights are invisible in the game — they only shade the cars — so the
// debug layer draws each one as a band at the radius it reaches, wide enough to
// read at a distance.
const POINT_RING_WIDTH = 0.02;

function buildGlowDefs(light: GlowLight, scale: number): GlowDef[] {
  const center = vec3.fromValues(
    light.position[0] * scale,
    light.position[1] * scale,
    light.position[2] * scale,
  );
  const radius = light.radius * scale;

  const colorA = glowColorFromRGBA32(light.colorA);
  const colorB = glowColorFromRGBA32(light.colorB);
  const defs: GlowDef[] = [];

  if (light.core !== 0)
    defs.push({
      center,
      colorA,
      colorB,
      radiusA: 0.0,
      radiusB: CORE_SCALE * radius * light.core,
      angle: 0.0,
      shape: RING_SHAPE,
    });

  // `addiu v0,s4,0x3` lands on Star1 for a star field of 1, so the field is the
  // number of bow-ties directly.
  if (light.star !== 0)
    defs.push({
      center,
      colorA,
      colorB,
      radiusA: radius,
      radiusB: STAR_OUTER_SCALE * radius,
      angle: 0.0,
      shape: GlowShape.Star1 + (light.star - 1),
    });

  if (light.halo !== 0) {
    const ring = HALO_SCALE * radius * light.halo;
    const width = HALO_HALF_WIDTH * scale;
    for (const outer of [ring + width, ring - width])
      defs.push({
        center,
        colorA,
        colorB,
        radiusA: ring,
        radiusB: outer,
        angle: 0.0,
        shape: RING_SHAPE,
      });
  }

  return defs;
}

// The authored colors run from a dim blue fill at 0.008 up to a warm white at
// 1.0, and a debug layer that fades out with them would be unreadable, so each
// ring is normalized to its own brightest channel.
function buildPointDef(light: PointLight, scale: number): GlowDef {
  const peak = Math.max(...light.color, Number.MIN_VALUE);
  const color = colorNewFromRGBA(
    light.color[0] / peak,
    light.color[1] / peak,
    light.color[2] / peak,
    1.0,
  );
  const radius = light.radius * scale;

  return {
    center: vec3.fromValues(
      light.position[0] * scale,
      light.position[1] * scale,
      light.position[2] * scale,
    ),
    colorA: color,
    colorB: color,
    radiusA: radius,
    radiusB: radius * (1.0 - POINT_RING_WIDTH),
    angle: 0.0,
    shape: RING_SHAPE,
  };
}

export class TrackLightLayers {
  // One entry per light, so a light's shapes stay together and the counts the
  // UI reports are light counts rather than draw counts.
  public readonly glows: GlowDef[][];
  public readonly points: GlowDef[];

  constructor(lights: TrackLights, scale: number) {
    this.glows = lights.glows.map((light) => buildGlowDefs(light, scale));
    this.points = lights.points.map((light) => buildPointDef(light, scale));
  }

  public get glowShapeCount(): number {
    return this.glows.reduce((total, defs) => total + defs.length, 0);
  }
}
