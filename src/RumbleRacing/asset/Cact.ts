import { parseChunks } from "./chunk";

export interface Actor {
  kind: "Actor";
  actorType: number;
  x: number;
  y: number;
  z: number;
  o3dResourceIndex: number;
  // `Cnet` resource this actor follows, or 0. Network_InitNetActor takes the
  // network from the actor's resource list, which is also how one path ends up
  // shared by several actors — a helicopter's body and its blades both name it.
  networkResourceIndex: number;
  // Network_InitNetActor copies this into the movement state's base speed.
  speed: number;
  raw: Uint8Array;
}

// The actor's resource list is a run of (fourCC, resource index) pairs. Most
// actors just name a model; the ones that travel also name a `Cnet` path, and a
// few name a second model.
const RESOURCE_FIRST_ENTRY = 0x0c;
const RESOURCE_ENTRY_SIZE = 0x08;
const RESOURCE_O3D = 0x10;

const TAG_CNET = 0x436e6574; // "Cnet"

// Movement parameters live at the tail of the actor header.
const HEADER_SPEED = 0x28;

export function parseActor(buf: Uint8Array): Actor {
  const chunks = parseChunks(buf);

  const header = chunks[0].payload.slice(8);
  const headerView = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );

  const actorType = header[4];
  const x = headerView.getFloat32(8, true);
  const y = headerView.getFloat32(12, true);
  const z = headerView.getFloat32(16, true);

  const resource = chunks[1];
  const resourceView = new DataView(
    resource.payload.buffer,
    resource.payload.byteOffset,
    resource.payload.byteLength,
  );
  const o3dResourceIndex = resourceView.getUint32(RESOURCE_O3D, true);

  let networkResourceIndex = 0;
  for (
    let off = RESOURCE_FIRST_ENTRY;
    off + RESOURCE_ENTRY_SIZE <= resource.payload.byteLength;
    off += RESOURCE_ENTRY_SIZE
  ) {
    if (resourceView.getUint32(off, true) !== TAG_CNET) continue;
    networkResourceIndex = resourceView.getUint32(off + 4, true);
    break;
  }

  const speed =
    header.byteLength >= HEADER_SPEED + 4
      ? headerView.getFloat32(HEADER_SPEED, true)
      : 0.0;

  return {
    kind: "Actor",
    actorType,
    x,
    y,
    z,
    o3dResourceIndex,
    networkResourceIndex,
    speed,
    raw: buf,
  };
}
