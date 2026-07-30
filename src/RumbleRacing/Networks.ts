import { Color, colorNewFromRGBA } from "../Color";
import { GfxDevice, GfxPrimitiveTopology } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import {
  GfxRenderInstList,
  GfxRenderInstManager,
} from "../gfx/render/GfxRenderInstManager";
import { ViewerRenderInput } from "../viewer";
import { Network, NetworkKind } from "./asset/cnet";
import { NetworkData } from "./rumbleRacing";
import { CollisionProgramMode } from "./CollisionProgram";
import {
  createDebugInputLayouts,
  createDebugLayer,
  DEBUG_POINT_STRIDE,
  DebugLayer,
  destroyDebugLayer,
  POINT_CORNERS,
  pushDebugLineSegment,
  submitDebugLayer,
} from "./DebugLayer";

// Draws the paths out of the track's `Cnet` resources: the line the AI cars
// follow, the outline the track map is built from, and one path per networked
// actor.

const RACING_LINE_COLOR = colorNewFromRGBA(0.2, 0.95, 1.0, 0.9);
const TRACK_MAP_COLOR = colorNewFromRGBA(1.0, 0.4, 0.9, 0.9);

// Actor paths get a colour each so overlapping ones stay tellable apart.
const ACTOR_COLORS: Color[] = [
  colorNewFromRGBA(1.0, 0.75, 0.2, 0.9),
  colorNewFromRGBA(0.6, 1.0, 0.35, 0.9),
  colorNewFromRGBA(1.0, 0.45, 0.35, 0.9),
  colorNewFromRGBA(0.75, 0.6, 1.0, 0.9),
];

// The line is the thing to read at a glance, so the nodes stay smaller than it.
const NODE_POINT_SIZE = 4.0;
const PATH_LINE_WIDTH = 5.0;

export interface NetworkLayer {
  name: string;
  pointCount: number;
  color: Color;
  edges: DebugLayer | null;
  nodes: DebugLayer | null;
}

function colorFor(network: NetworkData, actorIndex: number): Color {
  if (network.network.kind === NetworkKind.RacingLine && network.isRacingLine)
    return RACING_LINE_COLOR;
  if (network.network.kind === NetworkKind.TrackMap) return TRACK_MAP_COLOR;
  return ACTOR_COLORS[actorIndex % ACTOR_COLORS.length];
}

export class NetworkRenderer {
  public layers: NetworkLayer[] = [];

  constructor(
    private cache: GfxRenderCache,
    networks: NetworkData[],
    private scale: number,
  ) {
    const inputLayouts = createDebugInputLayouts(cache);

    let actorIndex = 0;
    for (const data of networks) {
      const color = colorFor(data, actorIndex);
      if (color === undefined) continue;
      if (data.network.kind !== NetworkKind.TrackMap && !data.isRacingLine)
        actorIndex++;

      this.layers.push({
        name: data.name,
        pointCount: data.network.points.length,
        color,
        edges: this.buildEdges(data.network, color, inputLayouts.line),
        nodes: this.buildNodes(data.network, color, inputLayouts.point),
      });
    }
  }

  // One line per connection, so branches and shortcuts show up as they are
  // stored rather than being flattened into a single loop.
  private buildEdges(
    network: Network,
    color: Color,
    inputLayout: DebugLayer["inputLayout"],
  ): DebugLayer | null {
    const vertexData: number[] = [];
    const indexData: number[] = [];

    for (const point of network.points) {
      for (const connection of point.connections) {
        if (connection < 0) continue;
        pushDebugLineSegment(
          vertexData,
          indexData,
          point.position,
          0,
          network.points[connection].position,
          0,
          color,
          this.scale,
        );
      }
    }

    return createDebugLayer(
      this.cache,
      new Float32Array(vertexData),
      new Uint32Array(indexData),
      inputLayout,
      CollisionProgramMode.ThickLine,
      GfxPrimitiveTopology.Triangles,
      PATH_LINE_WIDTH,
    );
  }

  private buildNodes(
    network: Network,
    color: Color,
    inputLayout: DebugLayer["inputLayout"],
  ): DebugLayer | null {
    const count = network.points.length;
    const vertexData = new Float32Array(count * 4 * DEBUG_POINT_STRIDE);
    const indexData = new Uint32Array(count * 6);

    for (let i = 0; i < count; i++) {
      const position = network.points[i].position;
      for (let corner = 0; corner < POINT_CORNERS.length; corner++) {
        let offs = (i * 4 + corner) * DEBUG_POINT_STRIDE;
        vertexData[offs++] = position[0] * this.scale;
        vertexData[offs++] = position[1] * this.scale;
        vertexData[offs++] = position[2] * this.scale;
        vertexData[offs++] = color.r;
        vertexData[offs++] = color.g;
        vertexData[offs++] = color.b;
        vertexData[offs++] = color.a;
        vertexData[offs++] = POINT_CORNERS[corner][0];
        vertexData[offs++] = POINT_CORNERS[corner][1];
      }

      const base = i * 4;
      const offs = i * 6;
      indexData[offs + 0] = base + 0;
      indexData[offs + 1] = base + 1;
      indexData[offs + 2] = base + 2;
      indexData[offs + 3] = base + 0;
      indexData[offs + 4] = base + 2;
      indexData[offs + 5] = base + 3;
    }

    return createDebugLayer(
      this.cache,
      vertexData,
      indexData,
      inputLayout,
      CollisionProgramMode.Point,
      GfxPrimitiveTopology.Triangles,
      NODE_POINT_SIZE,
    );
  }

  public submit(
    renderInstManager: GfxRenderInstManager,
    list: GfxRenderInstList,
    viewerInput: ViewerRenderInput,
    layer: NetworkLayer,
  ): void {
    for (const part of [layer.edges, layer.nodes]) {
      if (part === null) continue;
      submitDebugLayer(this.cache, renderInstManager, list, viewerInput, part);
    }
  }

  public destroy(device: GfxDevice): void {
    for (const layer of this.layers) {
      destroyDebugLayer(device, layer.edges);
      destroyDebugLayer(device, layer.nodes);
    }
  }
}
