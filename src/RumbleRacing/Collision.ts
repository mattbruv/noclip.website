import { colorNewFromRGBA } from "../Color";
import { GfxDevice, GfxPrimitiveTopology } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import {
  GfxRenderInstList,
  GfxRenderInstManager,
} from "../gfx/render/GfxRenderInstManager";
import { ViewerRenderInput } from "../viewer";
import { isDrivable, TrackCollision } from "./asset/gmd";
import { CollisionProgramMode } from "./CollisionProgram";
import {
  createDebugInputLayouts,
  createDebugLayer,
  DEBUG_MESH_STRIDE,
  DEBUG_POINT_STRIDE,
  DebugLayer,
  destroyDebugLayer,
  POINT_CORNERS,
  pushDebugLineSegment,
  pushDebugVertex,
  submitDebugLayer,
} from "./DebugLayer";

// Draws the collision mesh out of the track's `gmd ` resource: the polygons cars
// drive on, the vertices they are built from, and the fences that stop cars
// leaving the track.

const DRIVABLE_COLOR = colorNewFromRGBA(0.25, 0.85, 0.4, 0.4);
const BLOCKED_COLOR = colorNewFromRGBA(0.9, 0.25, 0.25, 0.4);
const VERTEX_COLOR = colorNewFromRGBA(1.0, 0.9, 0.3, 0.9);
const FENCE_COLOR = colorNewFromRGBA(0.35, 0.7, 1.0, 0.9);

// Side length in pixels of the quad each collision vertex is drawn as.
const VERTEX_POINT_SIZE = 7.0;
const FENCE_LINE_WIDTH = 3.0;

export class CollisionRenderer {
  public polygons: DebugLayer | null = null;
  public vertices: DebugLayer | null = null;
  public fences: DebugLayer | null = null;

  // The collision mesh is stored in the game's own units, like the rest of the
  // track geometry, so it gets the scene's global scale baked in.
  constructor(
    private cache: GfxRenderCache,
    collision: TrackCollision,
    private scale: number,
  ) {
    const inputLayouts = createDebugInputLayouts(cache);
    this.polygons = this.buildPolygons(collision, inputLayouts.mesh);
    this.vertices = this.buildVertices(collision, inputLayouts.point);
    this.fences = this.buildFences(collision, inputLayouts.line);
  }

  // Each polygon carries four indices; triangles repeat a vertex, so the second
  // triangle is dropped when it would be degenerate.
  private buildPolygons(
    collision: TrackCollision,
    inputLayout: DebugLayer["inputLayout"],
  ): DebugLayer | null {
    const vertexData: number[] = [];
    const indexData: number[] = [];

    for (const polygon of collision.polygons) {
      const color = isDrivable(polygon) ? DRIVABLE_COLOR : BLOCKED_COLOR;
      const [a, b, c, d] = polygon.vertexIndices;
      const base = vertexData.length / DEBUG_MESH_STRIDE;

      for (const index of polygon.vertexIndices)
        pushDebugVertex(
          vertexData,
          collision.vertices,
          index * 3,
          color,
          this.scale,
        );

      indexData.push(base + 0, base + 1, base + 2);
      if (d !== c && d !== a && d !== b)
        indexData.push(base + 0, base + 2, base + 3);
    }

    return createDebugLayer(
      this.cache,
      new Float32Array(vertexData),
      new Uint32Array(indexData),
      inputLayout,
      CollisionProgramMode.Mesh,
      GfxPrimitiveTopology.Triangles,
      0.0,
    );
  }

  private buildVertices(
    collision: TrackCollision,
    inputLayout: DebugLayer["inputLayout"],
  ): DebugLayer | null {
    const count = collision.vertices.length / 3;
    const vertexData = new Float32Array(count * 4 * DEBUG_POINT_STRIDE);
    const indexData = new Uint32Array(count * 6);

    for (let i = 0; i < count; i++) {
      for (let corner = 0; corner < POINT_CORNERS.length; corner++) {
        let offs = (i * 4 + corner) * DEBUG_POINT_STRIDE;
        vertexData[offs++] = collision.vertices[i * 3 + 0] * this.scale;
        vertexData[offs++] = collision.vertices[i * 3 + 1] * this.scale;
        vertexData[offs++] = collision.vertices[i * 3 + 2] * this.scale;
        vertexData[offs++] = VERTEX_COLOR.r;
        vertexData[offs++] = VERTEX_COLOR.g;
        vertexData[offs++] = VERTEX_COLOR.b;
        vertexData[offs++] = VERTEX_COLOR.a;
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
      VERTEX_POINT_SIZE,
    );
  }

  private buildFences(
    collision: TrackCollision,
    inputLayout: DebugLayer["inputLayout"],
  ): DebugLayer | null {
    const vertexData: number[] = [];
    const indexData: number[] = [];

    for (const fence of collision.fences) {
      const [from, to] = fence.vertexIndices;
      pushDebugLineSegment(
        vertexData,
        indexData,
        collision.vertices,
        from * 3,
        collision.vertices,
        to * 3,
        FENCE_COLOR,
        this.scale,
      );
    }

    return createDebugLayer(
      this.cache,
      new Float32Array(vertexData),
      new Uint32Array(indexData),
      inputLayout,
      CollisionProgramMode.ThickLine,
      GfxPrimitiveTopology.Triangles,
      FENCE_LINE_WIDTH,
    );
  }

  public submit(
    renderInstManager: GfxRenderInstManager,
    list: GfxRenderInstList,
    viewerInput: ViewerRenderInput,
    layer: DebugLayer,
  ): void {
    submitDebugLayer(this.cache, renderInstManager, list, viewerInput, layer);
  }

  public destroy(device: GfxDevice): void {
    for (const layer of [this.polygons, this.vertices, this.fences])
      destroyDebugLayer(device, layer);
  }
}
