import { vec3 } from "gl-matrix";
import { colorNewFromRGBA } from "../Color";
import { GlowDef, GlowShape, glowColorFromRGBA32 } from "./Glow";
import { GlowLight, PointLight, TrackLights } from "./asset/gmd";

const CORE_SCALE = 0.5;
const STAR_OUTER_SCALE = 1.5;
const HALO_SCALE = 0.4;
const HALO_HALF_WIDTH = 0.015625;
const RING_SHAPE = GlowShape.Ring32;
const POINT_RING_WIDTH = 0.02;

function buildGlowDefs(light: GlowLight, scale: number): GlowDef[] {
  const center = vec3.scale(vec3.create(), light.position, scale);
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
    center: vec3.scale(vec3.create(), light.position, scale),
    colorA: color,
    colorB: color,
    radiusA: radius,
    radiusB: radius * (1.0 - POINT_RING_WIDTH),
    angle: 0.0,
    shape: RING_SHAPE,
  };
}

export class TrackLightLayers {
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
