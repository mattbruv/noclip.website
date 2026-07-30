import { Color, colorNewFromRGBA } from "../Color";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { fillMatrix4x4, fillVec4 } from "../gfx/helpers/UniformBufferHelpers";
import {
  GfxBlendFactor,
  GfxBlendMode,
  GfxBufferFrequencyHint,
  GfxBufferUsage,
  GfxCompareMode,
  GfxCullMode,
  GfxDevice,
  GfxIndexBufferDescriptor,
  GfxMegaStateDescriptor,
  GfxPrimitiveTopology,
  GfxProgram,
  GfxVertexBufferDescriptor,
  GfxVertexBufferFrequency,
} from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxBuffer, GfxInputLayout } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import {
  GfxRenderInstList,
  GfxRenderInstManager,
} from "../gfx/render/GfxRenderInstManager";
import { ViewerRenderInput } from "../viewer";
import { isDrivable, TrackCollision } from "./asset/gmd";
import { CollisionProgram } from "./CollisionProgram";

// Debug visualisation of the collision mesh: the polygons cars drive on, the
// vertices they are built from, and the fences that stop cars leaving the track.

const DRIVABLE_COLOR = colorNewFromRGBA(0.25, 0.85, 0.4, 0.4);
const BLOCKED_COLOR = colorNewFromRGBA(0.9, 0.25, 0.25, 0.4);
const VERTEX_COLOR = colorNewFromRGBA(1.0, 0.9, 0.3, 0.9);
const FENCE_COLOR = colorNewFromRGBA(0.35, 0.7, 1.0, 0.9);

// Side length in pixels of the quad each collision vertex is drawn as.
const VERTEX_POINT_SIZE = 7.0;

// Position (3) + colour (4), plus a screen-space corner offset (2) for points.
const MESH_STRIDE = 7;
const POINT_STRIDE = 9;

interface CollisionLayer {
  vertexBuffer: GfxBuffer;
  indexBuffer: GfxBuffer;
  vertexBufferDescriptors: GfxVertexBufferDescriptor[];
  indexBufferDescriptor: GfxIndexBufferDescriptor;
  indexCount: number;
  inputLayout: GfxInputLayout;
  program: GfxProgram;
  topology: GfxPrimitiveTopology;
  megaStateFlags: Partial<GfxMegaStateDescriptor>;
}

function pushVertex(
  out: number[],
  vertices: Float32Array,
  index: number,
  color: Color,
  scale: number,
): void {
  out.push(
    vertices[index * 3 + 0] * scale,
    vertices[index * 3 + 1] * scale,
    vertices[index * 3 + 2] * scale,
    color.r,
    color.g,
    color.b,
    color.a,
  );
}

export class CollisionRenderer {
  public pointSize = VERTEX_POINT_SIZE;
  public polygons: CollisionLayer | null = null;
  public vertices: CollisionLayer | null = null;
  public fences: CollisionLayer | null = null;

  private meshInputLayout: GfxInputLayout;
  private pointInputLayout: GfxInputLayout;

  // The collision mesh is stored in the game's own units, like the rest of the
  // track geometry, so it gets the scene's global scale baked in.
  constructor(
    private cache: GfxRenderCache,
    collision: TrackCollision,
    private scale: number,
  ) {
    const attributes = (stride: number, withOffset: boolean) => ({
      vertexAttributeDescriptors: [
        {
          location: CollisionProgram.a_Position,
          format: GfxFormat.F32_RGB,
          bufferByteOffset: 0,
          bufferIndex: 0,
        },
        {
          location: CollisionProgram.a_Color,
          format: GfxFormat.F32_RGBA,
          bufferByteOffset: 3 * 4,
          bufferIndex: 0,
        },
        ...(withOffset
          ? [
              {
                location: CollisionProgram.a_Offset,
                format: GfxFormat.F32_RG,
                bufferByteOffset: 7 * 4,
                bufferIndex: 0,
              },
            ]
          : []),
      ],
      vertexBufferDescriptors: [
        {
          byteStride: stride * 4,
          frequency: GfxVertexBufferFrequency.PerVertex,
        },
      ],
      indexBufferFormat: GfxFormat.U32_R,
    });

    this.meshInputLayout = cache.createInputLayout(
      attributes(MESH_STRIDE, false),
    );
    this.pointInputLayout = cache.createInputLayout(
      attributes(POINT_STRIDE, true),
    );

    this.polygons = this.buildPolygons(collision);
    this.vertices = this.buildVertices(collision);
    this.fences = this.buildFences(collision);
  }

  private makeLayer(
    vertexData: Float32Array,
    indexData: Uint32Array,
    inputLayout: GfxInputLayout,
    pointMode: boolean,
    topology: GfxPrimitiveTopology,
    depthWrite: boolean,
  ): CollisionLayer | null {
    if (indexData.length === 0) return null;

    const device = this.cache.device;
    const vertexBuffer = createBufferFromData(
      device,
      GfxBufferUsage.Vertex,
      GfxBufferFrequencyHint.Static,
      vertexData.buffer,
    );
    const indexBuffer = createBufferFromData(
      device,
      GfxBufferUsage.Index,
      GfxBufferFrequencyHint.Static,
      indexData.buffer,
    );

    // The collision mesh sits just under the track surface it was built from, so
    // depth-testing it against the visible geometry would hide almost all of it.
    // These are inspection layers, so they draw as an overlay instead.
    const megaStateFlags: Partial<GfxMegaStateDescriptor> = {
      cullMode: GfxCullMode.None,
      depthWrite,
      depthCompare: GfxCompareMode.Always,
    };
    setAttachmentStateSimple(megaStateFlags, {
      blendMode: GfxBlendMode.Add,
      blendSrcFactor: GfxBlendFactor.SrcAlpha,
      blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
    });

    return {
      vertexBuffer,
      indexBuffer,
      vertexBufferDescriptors: [{ buffer: vertexBuffer, byteOffset: 0 }],
      indexBufferDescriptor: { buffer: indexBuffer, byteOffset: 0 },
      indexCount: indexData.length,
      inputLayout,
      program: this.cache.createProgram(new CollisionProgram(pointMode)),
      topology,
      megaStateFlags,
    };
  }

  // Each polygon carries four indices; triangles repeat a vertex, so the second
  // triangle is dropped when it would be degenerate.
  private buildPolygons(collision: TrackCollision): CollisionLayer | null {
    const vertexData: number[] = [];
    const indexData: number[] = [];

    for (const polygon of collision.polygons) {
      const color = isDrivable(polygon) ? DRIVABLE_COLOR : BLOCKED_COLOR;
      const [a, b, c, d] = polygon.vertexIndices;
      const base = vertexData.length / MESH_STRIDE;

      for (const index of polygon.vertexIndices)
        pushVertex(vertexData, collision.vertices, index, color, this.scale);

      indexData.push(base + 0, base + 1, base + 2);
      if (d !== c && d !== a && d !== b)
        indexData.push(base + 0, base + 2, base + 3);
    }

    return this.makeLayer(
      new Float32Array(vertexData),
      new Uint32Array(indexData),
      this.meshInputLayout,
      false,
      GfxPrimitiveTopology.Triangles,
      false,
    );
  }

  private buildVertices(collision: TrackCollision): CollisionLayer | null {
    const count = collision.vertices.length / 3;
    const vertexData = new Float32Array(count * 4 * POINT_STRIDE);
    const indexData = new Uint32Array(count * 6);
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    for (let i = 0; i < count; i++) {
      for (let corner = 0; corner < 4; corner++) {
        let offs = (i * 4 + corner) * POINT_STRIDE;
        vertexData[offs++] = collision.vertices[i * 3 + 0] * this.scale;
        vertexData[offs++] = collision.vertices[i * 3 + 1] * this.scale;
        vertexData[offs++] = collision.vertices[i * 3 + 2] * this.scale;
        vertexData[offs++] = VERTEX_COLOR.r;
        vertexData[offs++] = VERTEX_COLOR.g;
        vertexData[offs++] = VERTEX_COLOR.b;
        vertexData[offs++] = VERTEX_COLOR.a;
        vertexData[offs++] = corners[corner][0];
        vertexData[offs++] = corners[corner][1];
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

    return this.makeLayer(
      vertexData,
      indexData,
      this.pointInputLayout,
      true,
      GfxPrimitiveTopology.Triangles,
      false,
    );
  }

  private buildFences(collision: TrackCollision): CollisionLayer | null {
    const vertexData: number[] = [];
    const indexData: number[] = [];

    for (const fence of collision.fences) {
      const base = vertexData.length / MESH_STRIDE;
      for (const index of fence.vertexIndices)
        pushVertex(
          vertexData,
          collision.vertices,
          index,
          FENCE_COLOR,
          this.scale,
        );
      indexData.push(base + 0, base + 1);
    }

    return this.makeLayer(
      new Float32Array(vertexData),
      new Uint32Array(indexData),
      this.meshInputLayout,
      false,
      GfxPrimitiveTopology.Lines,
      false,
    );
  }

  public submit(
    renderInstManager: GfxRenderInstManager,
    list: GfxRenderInstList,
    viewerInput: ViewerRenderInput,
    layer: CollisionLayer,
  ): void {
    const renderInst = renderInstManager.newRenderInst();
    renderInst.setBindingLayouts([{ numSamplers: 0, numUniformBuffers: 1 }]);
    renderInst.setGfxProgram(layer.program);
    renderInst.setMegaStateFlags(layer.megaStateFlags);
    renderInst.setPrimitiveTopology(layer.topology);
    renderInst.setVertexInput(
      layer.inputLayout,
      layer.vertexBufferDescriptors,
      layer.indexBufferDescriptor,
    );
    renderInst.setDrawCount(layer.indexCount);

    const data = renderInst.allocateUniformBufferF32(
      CollisionProgram.ub_SceneParams,
      16 + 4,
    );
    let offs = 0;
    offs += fillMatrix4x4(data, offs, viewerInput.camera.clipFromWorldMatrix);
    fillVec4(
      data,
      offs,
      viewerInput.backbufferWidth,
      viewerInput.backbufferHeight,
      this.pointSize,
      0.0,
    );

    list.submitRenderInst(renderInst);
  }

  public destroy(device: GfxDevice): void {
    for (const layer of [this.polygons, this.vertices, this.fences]) {
      if (layer === null) continue;
      device.destroyBuffer(layer.vertexBuffer);
      device.destroyBuffer(layer.indexBuffer);
    }
  }
}
