// `Cnet` resources are the paths things follow around a track: the racing line
// the AI cars drive, the outline the track map is drawn from, and a path per
// networked actor (crop dusters, helicopters, planes).
//
// Network_DownloadData registers the network at resource+0xC and resolves any
// point whose Y is left at 0 against the terrain, the same way actors are placed.
// Network_FindValidConnectingPoint walks a point's two connection slots, so a
// network is a graph rather than a plain polyline — the racing line branches
// wherever the track offers a shortcut.

const NETWORK_OFFSET = 0xc;
const POINT_STRIDE = 0x20;

const NETWORK_ID = 0x00;
const NETWORK_POINT_COUNT = 0x02;

const POINT_POSITION = 0x04;
const POINT_RADIUS = 0x10;
const POINT_CONNECTIONS = 0x14;
const POINT_FLAGS = 0x18;
const POINT_SPEED = 0x1a;

export const CONNECTIONS_PER_POINT = 2;

// Network id from the resource header. Several actor paths share id 2, so it is a
// type rather than a unique key; the resource name says which is which.
export const enum NetworkKind {
  RacingLine = 0,
  TrackMap = 1,
  Actor = 2,
}

export interface NetworkPoint {
  position: [number, number, number];
  radius: number;
  // Indices of the points this one leads to; -1 for an empty slot.
  connections: number[];
  flags: number;
  // Only the racing line uses this, in steps of five.
  speed: number;
}

export interface Network {
  kind: number;
  points: NetworkPoint[];
}

export function parseNetwork(data: Uint8Array): Network | null {
  if (data.byteLength < NETWORK_OFFSET + POINT_STRIDE) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = view.getUint16(NETWORK_OFFSET + NETWORK_ID, true);
  const count = view.getInt16(NETWORK_OFFSET + NETWORK_POINT_COUNT, true);
  if (count <= 0) return null;

  const available =
    ((data.byteLength - NETWORK_OFFSET) / POINT_STRIDE) | 0;
  const pointCount = Math.min(count, available);

  const points: NetworkPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    const at = NETWORK_OFFSET + i * POINT_STRIDE;
    const connections: number[] = [];
    for (let slot = 0; slot < CONNECTIONS_PER_POINT; slot++) {
      const connection = view.getInt16(
        at + POINT_CONNECTIONS + slot * 2,
        true,
      );
      connections.push(connection >= 0 && connection < pointCount ? connection : -1);
    }

    points.push({
      position: [
        view.getFloat32(at + POINT_POSITION + 0x0, true),
        view.getFloat32(at + POINT_POSITION + 0x4, true),
        view.getFloat32(at + POINT_POSITION + 0x8, true),
      ],
      radius: view.getFloat32(at + POINT_RADIUS, true),
      connections,
      flags: view.getUint16(at + POINT_FLAGS, true),
      speed: view.getUint16(at + POINT_SPEED, true),
    });
  }

  return { kind, points };
}
