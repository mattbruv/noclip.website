import { readFourCC } from "../helpers/fourCC";

// The track's `gmd ` resource is a flat list of tagged records, walked by
// TrkInfo_ParseTrack. Everything the game needs to drive on the track lives in
// here: the collision mesh, the grid that indexes it, the fences that keep cars
// in bounds, the racing curve, and the sun.

export interface GmdRecord {
  tag: string;
  offset: number;
  size: number;
  // Payload start. Every record carries a 0x10 byte header.
  dataOffset: number;
  dataSize: number;
}

const RECORD_HEADER_SIZE = 0x10;

export function parseGmdRecords(data: Uint8Array): GmdRecord[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: GmdRecord[] = [];

  let offset = 0;
  while (offset + 8 <= data.byteLength) {
    const tag = readFourCC(data, offset);
    const size = view.getUint32(offset + 4, true);

    // The record list ends with padding rather than a terminator.
    if (!/^[\x20-\x7e]{4}$/.test(tag)) break;
    if (size < RECORD_HEADER_SIZE || offset + size > data.byteLength) break;

    records.push({
      tag,
      offset,
      size,
      dataOffset: offset + RECORD_HEADER_SIZE,
      dataSize: size - RECORD_HEADER_SIZE,
    });
    offset += size;
  }

  return records;
}

// Polygon surface bits. TrkInfo_GetTerrainInfoFunc and
// TrkInfo_GetFloorElevationFunc both skip a polygon outright when bit 0 is set,
// so that bit is what separates the surfaces a car can drive on from the rest of
// the collision mesh.
export const enum SurfaceFlags {
  NotDrivable = 1 << 0,
}

export interface CollisionPolygon {
  // Four indices into the vertex array; a triangle repeats its last vertex.
  vertexIndices: [number, number, number, number];
  flags: number;
}

export interface CollisionFence {
  vertexIndices: [number, number];
  flags: number;
}

export interface TrackCollision {
  // Positions, three floats per vertex, from the 16-byte quads in `GrVx`.
  vertices: Float32Array;
  polygons: CollisionPolygon[];
  fences: CollisionFence[];
  // The lookup grid `GrIn` indexes the mesh with one cell per world unit.
  gridWidth: number;
  gridHeight: number;
  gridOrigin: [number, number, number];
}

const VERTEX_STRIDE = 0x10;
const POLYGON_STRIDE = 0x10;
const FENCE_STRIDE = 0x08;

// Counts for all three arrays are stored together at the top of `GrIn`, which is
// also where TrkInfo_GetGridInfo reads the grid dimensions and origin from.
const GRID_WIDTH = 0x00;
const GRID_HEIGHT = 0x02;
const GRID_VERTEX_COUNT = 0x06;
const GRID_POLYGON_COUNT = 0x08;
const GRID_FENCE_COUNT = 0x0a;
const GRID_ORIGIN = 0x10;

export function parseTrackCollision(data: Uint8Array): TrackCollision | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records = parseGmdRecords(data);

  const find = (tag: string) => records.find((r) => r.tag === tag);
  const grid = find("GrIn");
  const vertexRecord = find("GrVx");
  const polygonRecord = find("GrPi");
  const fenceRecord = find("GrFi");

  if (
    grid === undefined ||
    vertexRecord === undefined ||
    polygonRecord === undefined
  )
    return null;

  const u16 = (offset: number) =>
    view.getUint16(grid.dataOffset + offset, true);
  const gridWidth = u16(GRID_WIDTH);
  const gridHeight = u16(GRID_HEIGHT);

  // Clamp the header counts to what the records can actually hold; the arrays
  // are padded out to a boundary.
  const vertexCount = Math.min(
    u16(GRID_VERTEX_COUNT),
    (vertexRecord.dataSize / VERTEX_STRIDE) | 0,
  );
  const polygonCount = Math.min(
    u16(GRID_POLYGON_COUNT),
    (polygonRecord.dataSize / POLYGON_STRIDE) | 0,
  );
  const fenceCount =
    fenceRecord !== undefined
      ? Math.min(
          u16(GRID_FENCE_COUNT),
          (fenceRecord.dataSize / FENCE_STRIDE) | 0,
        )
      : 0;

  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const at = vertexRecord.dataOffset + i * VERTEX_STRIDE;
    vertices[i * 3 + 0] = view.getFloat32(at + 0x0, true);
    vertices[i * 3 + 1] = view.getFloat32(at + 0x4, true);
    vertices[i * 3 + 2] = view.getFloat32(at + 0x8, true);
  }

  const polygons: CollisionPolygon[] = [];
  for (let i = 0; i < polygonCount; i++) {
    const at = polygonRecord.dataOffset + i * POLYGON_STRIDE;
    polygons.push({
      vertexIndices: [
        view.getUint16(at + 0x0, true),
        view.getUint16(at + 0x2, true),
        view.getUint16(at + 0x4, true),
        view.getUint16(at + 0x6, true),
      ],
      flags: view.getUint16(at + 0xe, true),
    });
  }

  const fences: CollisionFence[] = [];
  for (let i = 0; i < fenceCount; i++) {
    const at = fenceRecord!.dataOffset + i * FENCE_STRIDE;
    fences.push({
      vertexIndices: [
        view.getUint16(at + 0x0, true),
        view.getUint16(at + 0x2, true),
      ],
      flags: view.getUint16(at + 0x6, true),
    });
  }

  return {
    vertices,
    polygons,
    fences,
    gridWidth,
    gridHeight,
    gridOrigin: [
      view.getFloat32(grid.dataOffset + GRID_ORIGIN + 0x0, true),
      view.getFloat32(grid.dataOffset + GRID_ORIGIN + 0x4, true),
      view.getFloat32(grid.dataOffset + GRID_ORIGIN + 0x8, true),
    ],
  };
}

export function isDrivable(polygon: CollisionPolygon): boolean {
  return (polygon.flags & SurfaceFlags.NotDrivable) === 0;
}

// The `Ligh` record holds two unrelated light arrays back to back, split by a
// pair of counts in its header. TrkInfo_ParseTrack takes the first group to be
// glow billboards and the second to be the point lights that shade whatever
// drives past them, then hands each `Trck` section a slice of both:
//
//   piVar8 = piVar4 + 4;                   // group A = Ligh + 0x10
//   piVar9 = piVar4 + piVar4[2] * 8 + 4;   // group B = A + countA * 0x20
//
// Only the nine tracks that race at night carry the record at all.
const LIGHT_STRIDE = 0x20;
const LIGH_GLOW_COUNT = 0x08;
const LIGH_POINT_COUNT = 0x0c;

// A glow light, as TrkInfo_DrawLightGlows copies it into the engine-wide
// ColGlow list: the position quad becomes the billboard center, the float at
// +0x0c its radius, and the two color words the ends of its gradient.
export interface GlowLight {
  position: [number, number, number];
  radius: number;
  // Inner and outer color, packed 0xRRGGBBAA the way glowColorFromRGBA32 wants
  // them. Alpha is 0x80 (opaque, on the GS scale) at the inner end and 0x00 at
  // the outer end on every light in the game.
  colorA: number;
  colorB: number;
  // ColGlow_RenderAllGlowInCurrentList expands one definition into up to three
  // shapes when bit 7 of the shape byte is set, which is the mode
  // TrkInfo_DrawLightGlows selects. These are the fields it decodes out of the
  // rest of the byte; each is a size multiplier, and 0 means "skip this shape".
  core: number; // bits 0-1: the filled disc at the middle
  star: number; // bits 2-4: doubles as the point count, Star1 through Star4
  halo: number; // bits 5-6: a thin ring standing off the middle
}

// A point light. These never reach the glow list: TrkInfo_ComputeLightingEnvironment
// looks them up through the `GrLi` grid and picks the two strongest to shade
// nearby objects, so nothing about them is directly visible.
export interface PointLight {
  position: [number, number, number];
  radius: number;
  color: [number, number, number];
  // Next light in the same `GrLi` cell, -1 to end the chain.
  next: number;
}

export interface TrackLights {
  glows: GlowLight[];
  points: PointLight[];
}

export function parseTrackLights(data: Uint8Array): TrackLights | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const record = parseGmdRecords(data).find((r) => r.tag === "Ligh");
  if (record === undefined) return null;

  const capacity = (record.dataSize / LIGHT_STRIDE) | 0;
  const glowCount = view.getUint32(record.offset + LIGH_GLOW_COUNT, true);
  const pointCount = view.getUint32(record.offset + LIGH_POINT_COUNT, true);
  if (glowCount + pointCount > capacity) return null;

  const position = (at: number): [number, number, number] => [
    view.getFloat32(at + 0x0, true),
    view.getFloat32(at + 0x4, true),
    view.getFloat32(at + 0x8, true),
  ];

  const glows: GlowLight[] = [];
  for (let i = 0; i < glowCount; i++) {
    const at = record.dataOffset + i * LIGHT_STRIDE;
    // The color words are stored R,G,B,A in memory order, so reading them big
    // end first lands them in 0xRRGGBBAA without a swap.
    const shape = view.getUint8(at + 0x18);
    glows.push({
      position: position(at),
      radius: view.getFloat32(at + 0xc, true),
      colorA: view.getUint32(at + 0x10, false),
      colorB: view.getUint32(at + 0x14, false),
      core: shape & 0x3,
      star: (shape >>> 2) & 0x7,
      halo: (shape >>> 5) & 0x3,
    });
  }

  const points: PointLight[] = [];
  const pointBase = record.dataOffset + glowCount * LIGHT_STRIDE;
  for (let i = 0; i < pointCount; i++) {
    const at = pointBase + i * LIGHT_STRIDE;
    points.push({
      position: position(at),
      radius: view.getFloat32(at + 0xc, true),
      color: [
        view.getFloat32(at + 0x10, true),
        view.getFloat32(at + 0x14, true),
        view.getFloat32(at + 0x18, true),
      ],
      next: view.getInt32(at + 0x1c, true),
    });
  }

  return { glows, points };
}
