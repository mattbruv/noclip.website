import { readFileSync, writeFileSync } from "fs";
import { getResource, getResourceList, parseTrackFile } from "../file/track";
import { ActorMatrix, ActorTransforms, ActorType } from "../rumbleRacing";

// Standalone tool designed for node to fill in actor placement.
//
// The track file only stores an actor's authored X and Z reliably; Y is usually
// left at 0 for the engine to resolve against the terrain during init, and a
// static actor's final basis is built at runtime too. The only place the result
// exists is in a running game, so this scrapes it out of a PCSX2 memory dump and
// merges it into the per-track JSON the scene loads alongside the .TRK.
//
// This is the same trick as scripts/searchY.py in the reverse engineering repo,
// with two additions: it covers power-ups, which that script skips because they
// have no O3DResourceIndex, and it falls back to a tolerant position match for
// actors whose coordinates the game rewrites slightly.
//
// Existing entries are never overwritten, so it is safe to re-run over JSON that
// searchY.py produced.
//
// Usage:
//   npx tsx src/RumbleRacing/tools/actorTransforms.ts [dumpDir] [dataDir]
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
// position), so the position row is at actor+0x40 and the actor itself starts
// 0x40 earlier. The exe-command function pointer at actor+0xAC is what
// distinguishes a live actor from the copy of the resource chunk that is also
// resident in RAM.
const ROW_FLOATS = 4;
const POSITION_ROW = 3;
const MATRIX_FLOATS = 4 * ROW_FLOATS;
const EXE_CMD_WORD = 43; // (0xAC - -0x40) / 4, relative to the matrix start
const CODE_START = 0x100000;
const CODE_END = 0x800000;

// How far the runtime position may drift from the authored one before a match is
// rejected. Zero for the usual case, where the floats survive init bit-for-bit.
const POSITION_TOLERANCE = 0.01;

interface Actor {
  resourceIndex: number;
  actorType: number;
  hasModel: boolean;
  x: number;
  y: number;
  z: number;
}

function readActors(short: string): Actor[] {
  const path = `${dataDir}/DATA/LOC${short.slice(0, 2)}/${short}.TRK`;
  const track = parseTrackFile(new Uint8Array(readFileSync(path)), short);

  const actors: Actor[] = [];
  for (const entry of getResourceList(track).entries) {
    if (entry.typeTag !== "Cact") continue;
    const actor = getResource(track, entry);
    if (actor.kind !== "Actor") continue;
    actors.push({
      resourceIndex: entry.resourceIndex,
      actorType: actor.actorType,
      hasModel: actor.o3dResourceIndex > 0,
      x: actor.x,
      y: actor.y,
      z: actor.z,
    });
  }
  return actors;
}

// A candidate is only accepted if the three rows in front of the position look
// like direction vectors (w == 0) and the position itself is a point (w == 1).
// The bound on the basis components allows for the scaled matrices some actors
// carry.
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

interface Match {
  rows: Float32Array;
  live: boolean;
}

interface Dump {
  words: Uint32Array;
  floats: Float32Array;
}

function openDump(dump: string): Dump {
  const memory = readFileSync(`${dumpDir}/${dump}/eeMemory.bin`);
  return {
    words: new Uint32Array(
      memory.buffer,
      memory.byteOffset,
      memory.byteLength >> 2,
    ),
    floats: new Float32Array(
      memory.buffer,
      memory.byteOffset,
      memory.byteLength >> 2,
    ),
  };
}

// Collects every matrix in the dump whose position row matches one of the given
// actors, keyed by resource index. `tolerance` of 0 compares the raw float bits.
function findMatrices(
  { words, floats }: Dump,
  actors: Actor[],
  tolerance: number,
): Map<number, Match[]> {
  const firstRow = POSITION_ROW * ROW_FLOATS;

  // Bucket the actors so the per-word test stays cheap.
  const byX = new Map<number, Actor[]>();
  const bucket = (key: number, actor: Actor) => {
    let list = byX.get(key);
    if (list === undefined) byX.set(key, (list = []));
    list.push(actor);
  };
  for (const actor of actors) {
    if (tolerance === 0) bucket(floatBits(actor.x), actor);
    else
      for (const key of new Set([
        Math.floor(actor.x - tolerance),
        Math.floor(actor.x + tolerance),
      ]))
        bucket(key, actor);
  }

  const found = new Map<number, Match[]>();
  for (let i = firstRow; i + ROW_FLOATS <= floats.length; i++) {
    const key = tolerance === 0 ? words[i] : Math.floor(floats[i]);
    const candidates = byX.get(key);
    if (candidates === undefined) continue;

    for (const actor of candidates) {
      if (tolerance === 0) {
        if (floats[i + 2] !== actor.z) continue;
      } else {
        if (Math.abs(floats[i] - actor.x) > tolerance) continue;
        if (Math.abs(floats[i + 2] - actor.z) > tolerance) continue;
      }

      const start = i - firstRow;
      const rows = floats.slice(start, start + MATRIX_FLOATS);
      if (!isPlausibleMatrix(rows)) continue;

      const exeCmd = words[start - ROW_FLOATS + EXE_CMD_WORD];
      const live =
        exeCmd >= CODE_START && exeCmd < CODE_END && (exeCmd & 3) === 0;

      let list = found.get(actor.resourceIndex);
      if (list === undefined) found.set(actor.resourceIndex, (list = []));
      list.push({ rows, live });
    }
  }
  return found;
}

function positionsAgree(matches: Match[]): boolean {
  const first = matches[0].rows;
  return matches.every((m) =>
    [0, 1, 2].every(
      (i) =>
        m.rows[POSITION_ROW * ROW_FLOATS + i] ===
        first[POSITION_ROW * ROW_FLOATS + i],
    ),
  );
}

function toMatrix(rows: Float32Array): ActorMatrix {
  const row = (index: number): [number, number, number, number] => [
    rows[index * ROW_FLOATS + 0],
    rows[index * ROW_FLOATS + 1],
    rows[index * ROW_FLOATS + 2],
    rows[index * ROW_FLOATS + 3],
  ];
  return [row(0), row(1), row(2), row(3)];
}

// The rotation a pickup happens to be caught at is meaningless — it is either a
// terrain-aligned basis that powerUp_Simulate is about to overwrite, or a
// snapshot of the spin — so only the position is kept and the renderer generates
// the spin itself.
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
  const actors = readActors(short);
  const jsonPath = `${dataDir}/json/${short}.json`;
  const transforms = JSON.parse(
    readFileSync(jsonPath, "utf8"),
  ) as ActorTransforms;

  const memory = openDump(dump);
  const report = { powerUps: 0, actors: 0, ambiguous: 0, absent: 0 };

  const powerUps = actors.filter((a) => a.actorType === ActorType.PowerUp);
  for (const [resourceIndex, matches] of findMatrices(memory, powerUps, 0)) {
    if (!positionsAgree(matches)) {
      report.ambiguous++;
      continue;
    }
    transforms[resourceIndex] = positionOnlyMatrix(matches[0].rows);
    report.powerUps++;
  }

  // Actors that render but have no entry yet: whatever searchY.py could not
  // resolve, plus anything it skipped.
  const unplaced = actors.filter(
    (a) =>
      a.hasModel &&
      a.actorType !== ActorType.PowerUp &&
      transforms[a.resourceIndex] === undefined,
  );

  const exact = findMatrices(memory, unplaced, 0);
  const stillUnplaced = unplaced.filter(
    (a) =>
      !exact.has(a.resourceIndex) ||
      !positionsAgree(exact.get(a.resourceIndex)!),
  );

  // Actors whose coordinates the game recomputes land near the authored value
  // rather than on it, which only stays unambiguous if the match is inside a
  // live actor.
  const tolerant = findMatrices(memory, stillUnplaced, POSITION_TOLERANCE);

  for (const actor of unplaced) {
    let matches = exact.get(actor.resourceIndex);
    if (matches === undefined || !positionsAgree(matches)) {
      matches = tolerant.get(actor.resourceIndex)?.filter((m) => m.live);
      if (matches === undefined || matches.length === 0) {
        report.absent++;
        continue;
      }
      if (!positionsAgree(matches)) {
        report.ambiguous++;
        continue;
      }
    }
    transforms[actor.resourceIndex] = toMatrix(matches[0].rows);
    report.actors++;
  }

  writeFileSync(jsonPath, `${JSON.stringify(transforms, null, 2)}\n`);

  console.log(
    `${short}: ${report.powerUps} power-ups, ${report.actors} previously unplaced actor(s) recovered, ` +
      `${report.ambiguous} ambiguous, ${report.absent} not present in the capture -> ${jsonPath}`,
  );
}
