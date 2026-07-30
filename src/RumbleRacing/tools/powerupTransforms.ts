import { readFileSync, writeFileSync } from "fs";
import { getResource, getResourceList, parseTrackFile } from "../file/track";
import { ActorMatrix, ActorTransforms, ActorType } from "../rumbleRacing";

// Standalone tool designed for node to fill in power-up pickup placement.
//
// Power-up actors (ActorType 8) are spawned from the track file with their Y
// left at 0; TrkInfo_GetTerrainInfoFunc lifts each one to hover height during
// init, so the only place the real position exists is in a running game. This
// scrapes it out of a PCSX2 memory dump, the same trick scripts/searchY.py uses
// for the rest of the actors, and merges the result into the per-track JSON
// that the scene loads alongside the .TRK.
//
// Usage:
//   npx tsx src/RumbleRacing/tools/powerupTransforms.ts [dumpDir] [dataDir]
//
// dumpDir defaults to the layout of the reverse engineering repo, i.e. one
// subdirectory per track each containing PCSX2's eeMemory.bin, captured right
// after the track finishes loading.

const TRACKS: { short: string; dump: string }[] = [
  { short: "BB1", dump: "sun_burn" },
  { short: "BB2", dump: "surf_and_turf" },
  { short: "BL1", dump: "so_refined" },
  { short: "BL2", dump: "coal_cuts" },
  { short: "DA1", dump: "flip_out" },
  { short: "DA2", dump: "the_gauntlet" },
  { short: "DA3", dump: "wild_kingdom" },
  { short: "JT1", dump: "circus_minimus" },
  { short: "JT2", dump: "outer_limits" },
  { short: "MA1", dump: "passing_through" },
  { short: "MA2", dump: "falls_down" },
  { short: "MP1", dump: "touch_and_go" },
  { short: "MP2", dump: "car_go" },
  { short: "SE1", dump: "true_grits" },
  { short: "SE2", dump: "over_easy" },
];

const dumpDir = process.argv[2] ?? `../rumble-racing-re/rumble-reader/dumps`;
const dataDir = process.argv[3] ?? `./data/RumbleRacing`;

// An actor's model matrix sits at actor+0x10 as four rows (right, up, forward,
// position). The position row is the anchor: X and Z survive init untouched, so
// they can be matched against the values in the track file.
const MATRIX_ROWS = 4;
const ROW_FLOATS = 4;
const POSITION_ROW = 3;

interface PowerUpActor {
  resourceIndex: number;
  x: number;
  y: number;
  z: number;
}

function readPowerUpActors(short: string): PowerUpActor[] {
  const path = `${dataDir}/DATA/LOC${short.slice(0, 2)}/${short}.TRK`;
  const track = parseTrackFile(new Uint8Array(readFileSync(path)), short);

  const actors: PowerUpActor[] = [];
  for (const entry of getResourceList(track).entries) {
    if (entry.typeTag !== "Cact") continue;
    const actor = getResource(track, entry);
    if (actor.kind !== "Actor" || actor.actorType !== ActorType.PowerUp)
      continue;
    actors.push({
      resourceIndex: entry.resourceIndex,
      x: actor.x,
      y: actor.y,
      z: actor.z,
    });
  }
  return actors;
}

// A candidate is only accepted if the three rows in front of the position look
// like direction vectors (w == 0) and the position itself is a point (w == 1).
function isPlausibleMatrix(rows: Float32Array): boolean {
  for (let row = 0; row < POSITION_ROW; row++) {
    for (let i = 0; i < 3; i++)
      if (!(Math.abs(rows[row * ROW_FLOATS + i]) <= 130.0)) return false;
    if (Math.abs(rows[row * ROW_FLOATS + 3]) > 0.01) return false;
  }
  return Math.abs(rows[POSITION_ROW * ROW_FLOATS + 3] - 1.0) <= 0.01;
}

const floatBits = (() => {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  return (value: number): number => {
    f32[0] = value;
    return u32[0];
  };
})();

function scrapePositions(
  memory: Buffer,
  actors: PowerUpActor[],
): Map<number, Float32Array> {
  const words = new Uint32Array(
    memory.buffer,
    memory.byteOffset,
    memory.byteLength >> 2,
  );
  const floats = new Float32Array(
    memory.buffer,
    memory.byteOffset,
    memory.byteLength >> 2,
  );

  const byX = new Map<number, PowerUpActor[]>();
  for (const actor of actors) {
    const key = floatBits(actor.x);
    let bucket = byX.get(key);
    if (bucket === undefined) byX.set(key, (bucket = []));
    bucket.push(actor);
  }

  const found = new Map<number, Float32Array>();
  const conflicting = new Set<number>();
  const firstRow = (MATRIX_ROWS - 1) * ROW_FLOATS;

  for (let i = firstRow; i + ROW_FLOATS <= floats.length; i++) {
    const candidates = byX.get(words[i]);
    if (candidates === undefined) continue;

    for (const actor of candidates) {
      if (floats[i + 2] !== actor.z) continue;

      const rows = floats.slice(i - firstRow, i - firstRow + 16);
      if (!isPlausibleMatrix(rows)) continue;

      const previous = found.get(actor.resourceIndex);
      if (previous !== undefined) {
        if (previous[POSITION_ROW * ROW_FLOATS + 1] !== rows[13])
          conflicting.add(actor.resourceIndex);
        continue;
      }
      found.set(actor.resourceIndex, rows);
    }
  }

  for (const resourceIndex of conflicting) {
    console.warn(`    ! actor ${resourceIndex}: conflicting heights, skipped`);
    found.delete(resourceIndex);
  }

  return found;
}

// The scraped rotation is just whatever spin angle the pickup happened to be at
// (and, before the first simulate tick, a terrain-aligned basis that
// powerUp_Simulate immediately overwrites), so only the position is kept. The
// renderer generates the spin itself.
function positionOnlyMatrix(rows: Float32Array): ActorMatrix {
  const position = POSITION_ROW * ROW_FLOATS;
  return [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [rows[position + 0], rows[position + 1], rows[position + 2], 1],
  ];
}

for (const { short, dump } of TRACKS) {
  const actors = readPowerUpActors(short);
  const memory = readFileSync(`${dumpDir}/${dump}/eeMemory.bin`);
  const scraped = scrapePositions(memory, actors);

  const jsonPath = `${dataDir}/json/${short}.json`;
  const transforms = JSON.parse(
    readFileSync(jsonPath, "utf8"),
  ) as ActorTransforms;

  for (const [resourceIndex, rows] of scraped)
    transforms[resourceIndex] = positionOnlyMatrix(rows);

  writeFileSync(jsonPath, `${JSON.stringify(transforms, null, 2)}\n`);

  console.log(
    `${short}: ${scraped.size}/${actors.length} power-ups placed -> ${jsonPath}`,
  );
}
