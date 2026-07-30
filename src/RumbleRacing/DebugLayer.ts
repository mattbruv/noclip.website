import { Color } from "../Color";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import {
  fillMatrix4x4,
  fillVec3v,
  fillVec4,
} from "../gfx/helpers/UniformBufferHelpers";
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
  GfxVertexBufferDescriptor,
  GfxVertexBufferFrequency,
} from "../gfx/platform/GfxPlatform";
import { reverseDepthForCompareMode } from "../gfx/helpers/ReversedDepthHelpers";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxBuffer, GfxInputLayout } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import {
  GfxRenderInstList,
  GfxRenderInstManager,
} from "../gfx/render/GfxRenderInstManager";
import { ViewerRenderInput } from "../viewer";
import { CollisionProgram, CollisionProgramMode } from "./CollisionProgram";

// Shared plumbing for the inspection layers built out of the track's `gmd ` and
// `Cnet` resources. They all draw the same way: flat vertex-coloured triangles or
// lines, as an overlay rather than depth-tested geometry, since the data they
// visualise sits under or inside the geometry it describes.

// Position (3) + colour (4), plus a screen-space offset (2) for points, and the
// segment's other endpoint (3) for thick lines.
export const DEBUG_MESH_STRIDE = 7;
export const DEBUG_POINT_STRIDE = 9;
export const DEBUG_LINE_STRIDE = 12;

export interface DebugLayer {
  vertexBuffer: GfxBuffer;
  indexBuffer: GfxBuffer;
  vertexBufferDescriptors: GfxVertexBufferDescriptor[];
  indexBufferDescriptor: GfxIndexBufferDescriptor;
  indexCount: number;
  inputLayout: GfxInputLayout;
  mode: CollisionProgramMode;
  topology: GfxPrimitiveTopology;
  // Pixel size: the side of a point's quad, or the width of a line ribbon.
  size: number;
}

export interface DebugInputLayouts {
  mesh: GfxInputLayout;
  point: GfxInputLayout;
  line: GfxInputLayout;
}

export function createDebugInputLayouts(
  cache: GfxRenderCache,
): DebugInputLayouts {
  const describe = (
    stride: number,
    withOffset: boolean,
    withOther = false,
  ) => ({
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
      ...(withOther
        ? [
            {
              location: CollisionProgram.a_Other,
              format: GfxFormat.F32_RGB,
              bufferByteOffset: 9 * 4,
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

  return {
    mesh: cache.createInputLayout(describe(DEBUG_MESH_STRIDE, false)),
    point: cache.createInputLayout(describe(DEBUG_POINT_STRIDE, true)),
    line: cache.createInputLayout(describe(DEBUG_LINE_STRIDE, true, true)),
  };
}

export function pushDebugVertex(
  out: number[],
  position: ArrayLike<number>,
  offset: number,
  color: Color,
  scale: number,
): void {
  out.push(
    position[offset + 0] * scale,
    position[offset + 1] * scale,
    position[offset + 2] * scale,
    color.r,
    color.g,
    color.b,
    color.a,
  );
}

// The quad corners a point is expanded into, in screen space.
export const POINT_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

// One screen-space ribbon per segment: both endpoints twice, each carrying the
// opposite endpoint so the shader can work out the segment's screen direction.
// The sides at the far endpoint are flipped, since its direction vector points
// back the other way.
export function pushDebugLineSegment(
  out: number[],
  indices: number[],
  from: ArrayLike<number>,
  fromOffset: number,
  to: ArrayLike<number>,
  toOffset: number,
  color: Color,
  scale: number,
): void {
  const base = out.length / DEBUG_LINE_STRIDE;

  const push = (
    position: ArrayLike<number>,
    positionOffset: number,
    other: ArrayLike<number>,
    otherOffset: number,
    side: number,
  ) => {
    out.push(
      position[positionOffset + 0] * scale,
      position[positionOffset + 1] * scale,
      position[positionOffset + 2] * scale,
      color.r,
      color.g,
      color.b,
      color.a,
      side,
      0.0,
      other[otherOffset + 0] * scale,
      other[otherOffset + 1] * scale,
      other[otherOffset + 2] * scale,
    );
  };

  push(from, fromOffset, to, toOffset, 1.0);
  push(from, fromOffset, to, toOffset, -1.0);
  push(to, toOffset, from, fromOffset, -1.0);
  push(to, toOffset, from, fromOffset, 1.0);

  indices.push(base + 0, base + 1, base + 2, base + 0, base + 2, base + 3);
}

export function createDebugLayer(
  cache: GfxRenderCache,
  vertexData: Float32Array,
  indexData: Uint32Array,
  inputLayout: GfxInputLayout,
  mode: CollisionProgramMode,
  topology: GfxPrimitiveTopology,
  size: number,
): DebugLayer | null {
  if (indexData.length === 0) return null;

  const device = cache.device;
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

  return {
    vertexBuffer,
    indexBuffer,
    vertexBufferDescriptors: [{ buffer: vertexBuffer, byteOffset: 0 }],
    indexBufferDescriptor: { buffer: indexBuffer, byteOffset: 0 },
    indexCount: indexData.length,
    inputLayout,
    mode,
    topology,
    size,
  };
}

// How far towards the camera these layers are pulled, in scene units, to beat
// z-fighting with the coplanar track surface. Measured against the visible track
// mesh, the collision mesh coincides with it to within about a unit, so this only
// has to clear that.
const DEPTH_OFFSET = 60.0;

// Depth-tested like everything else, so the track geometry occludes them.
const megaStateFlags: Partial<GfxMegaStateDescriptor> = {
  cullMode: GfxCullMode.None,
  depthWrite: false,
  depthCompare: reverseDepthForCompareMode(GfxCompareMode.Less),
};
setAttachmentStateSimple(megaStateFlags, {
  blendMode: GfxBlendMode.Add,
  blendSrcFactor: GfxBlendFactor.SrcAlpha,
  blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
});

export function submitDebugLayer(
  cache: GfxRenderCache,
  renderInstManager: GfxRenderInstManager,
  list: GfxRenderInstList,
  viewerInput: ViewerRenderInput,
  layer: DebugLayer,
): void {
  const renderInst = renderInstManager.newRenderInst();
  renderInst.setBindingLayouts([{ numSamplers: 0, numUniformBuffers: 1 }]);
  renderInst.setGfxProgram(
    cache.createProgram(new CollisionProgram(layer.mode)),
  );
  renderInst.setMegaStateFlags(megaStateFlags);
  renderInst.setPrimitiveTopology(layer.topology);
  renderInst.setVertexInput(
    layer.inputLayout,
    layer.vertexBufferDescriptors,
    layer.indexBufferDescriptor,
  );
  renderInst.setDrawCount(layer.indexCount);

  const data = renderInst.allocateUniformBufferF32(
    CollisionProgram.ub_SceneParams,
    16 + 4 + 4,
  );
  let offs = 0;
  offs += fillMatrix4x4(data, offs, viewerInput.camera.clipFromWorldMatrix);
  offs += fillVec4(
    data,
    offs,
    viewerInput.backbufferWidth,
    viewerInput.backbufferHeight,
    layer.size,
    DEPTH_OFFSET,
  );
  // The camera's world position is the translation of its world matrix.
  fillVec3v(data, offs, [
    viewerInput.camera.worldMatrix[12],
    viewerInput.camera.worldMatrix[13],
    viewerInput.camera.worldMatrix[14],
  ]);

  list.submitRenderInst(renderInst);
}

export function destroyDebugLayer(
  device: GfxDevice,
  layer: DebugLayer | null,
): void {
  if (layer === null) return;
  device.destroyBuffer(layer.vertexBuffer);
  device.destroyBuffer(layer.indexBuffer);
}
