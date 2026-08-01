import { vec3 } from "gl-matrix";
import { Color, colorNewFromRGBA } from "../../Color";
import { readFourCC } from "../helpers/fourCC";

export interface GmdRecord {
  tag: string;
  offset: number;
  size: number;
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

const LIGHT_STRIDE = 0x20;
const LIGH_GLOW_COUNT = 0x08;
const LIGH_POINT_COUNT = 0x0c;

export interface GlowLight {
  position: vec3;
  radius: number;
  colorA: number;
  colorB: number;
  core: number;
  star: number;
  halo: number;
}

export interface PointLight {
  position: vec3;
  radius: number;
  color: Color;
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

  const position = (at: number): vec3 =>
    vec3.fromValues(
      view.getFloat32(at + 0x0, true),
      view.getFloat32(at + 0x4, true),
      view.getFloat32(at + 0x8, true),
    );

  const glows: GlowLight[] = [];
  for (let i = 0; i < glowCount; i++) {
    const at = record.dataOffset + i * LIGHT_STRIDE;
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
      color: colorNewFromRGBA(
        view.getFloat32(at + 0x10, true),
        view.getFloat32(at + 0x14, true),
        view.getFloat32(at + 0x18, true),
      ),
      next: view.getInt32(at + 0x1c, true),
    });
  }

  return { glows, points };
}
