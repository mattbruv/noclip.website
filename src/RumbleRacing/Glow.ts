import { ReadonlyVec3 } from "gl-matrix";
import { Color, colorNewFromRGBA } from "../Color";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { reverseDepthForCompareMode } from "../gfx/helpers/ReversedDepthHelpers";
import {
  fillColor,
  fillMatrix4x3,
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
import { GlowProgram } from "./GlowProgram";

// The engine-wide billboard "glow" system (UColGlow.c). Sun flares, track light
// glows, lightning, the pickup flash and the power-up sparkle all feed a
// per-frame list of glow definitions that VU1 turns into screen-facing gradient
// strips.

// gGlowStripList, as built by ColGlow_MakeShapes. Only the shapes a scene
// actually asks for get uploaded.
export const enum GlowShape {
  Ring10,
  Ring16,
  Ring24,
  Ring32,
  Star1,
  Star2,
  Star3,
  Star4,
  Ring3,
  Ring4,
  Ring5,
  Ring6,
  Ring8,
}

const GLOW_SHAPE_PARAMS: { star: boolean; count: number }[] = [
  { star: false, count: 10 },
  { star: false, count: 16 },
  { star: false, count: 24 },
  { star: false, count: 32 },
  { star: true, count: 1 },
  { star: true, count: 2 },
  { star: true, count: 3 },
  { star: true, count: 4 },
  { star: false, count: 3 },
  { star: false, count: 4 },
  { star: false, count: 5 },
  { star: false, count: 6 },
  { star: false, count: 8 },
];

export interface GlowDef {
  center: ReadonlyVec3;
  colorA: Color;
  colorB: Color;
  radiusA: number;
  radiusB: number;
  angle: number;
  shape: GlowShape;
}

// The GS treats primitive RGB as 0...255, but alpha as 0...128 (0x80 == 1.0).
export function glowColorFromRGBA32(rgba: number): Color {
  return colorNewFromRGBA(
    ((rgba >>> 24) & 0xff) / 0xff,
    ((rgba >>> 16) & 0xff) / 0xff,
    ((rgba >>> 8) & 0xff) / 0xff,
    (rgba & 0xff) / 0x80,
  );
}

const VERTEX_STRIDE = 3;

// A glow strip alternates between the two vertex classes; VU1 keys off the low
// bit of each vertex's tag (`iand vi09, vi13, vi07`) to decide which
// radius/color pair to use. Class 1 (odd tag) is A, class 0 (even tag) is B.
class GlowStripBuilder {
  private vertices: number[] = [];
  private indices: number[] = [];
  private stripStart = 0;

  public startStrip(): void {
    this.stripStart = this.vertices.length / VERTEX_STRIDE;
  }

  // ColGlow_AddVertex, with the class taken from bit 0 of the vertex tag. The
  // first two vertices of a strip carry the tag's bit 1 as well, which is what
  // suppresses a triangle until the strip has been primed.
  public addPoint(x: number, y: number, vertexClass: number): void {
    const index = this.vertices.length / VERTEX_STRIDE;
    this.vertices.push(x, y, vertexClass);

    // Triangulate the strip as it grows. Winding does not matter: glows are
    // drawn with culling off, exactly like the rest of the game's geometry.
    if (index >= this.stripStart + 2)
      this.indices.push(index - 2, index - 1, index);
  }

  // One call per outline point: the same direction is emitted twice, once for
  // each class, so the strip spans from radius A to radius B.
  public addPointPair(x: number, y: number): void {
    this.addPoint(x, y, 1.0);
    this.addPoint(x, y, 0.0);
  }

  public finish(): { vertices: Float32Array; indices: Uint32Array } {
    return {
      vertices: new Float32Array(this.vertices),
      indices: new Uint32Array(this.indices),
    };
  }
}

// ColGlow_CreateRing: segments+1 point pairs around the unit circle, closing
// back on the first point.
function buildRing(segments: number): GlowStripBuilder {
  const builder = new GlowStripBuilder();
  builder.startStrip();

  for (let i = 0; i <= segments; i++) {
    const theta = (i * 2.0 * Math.PI) / segments;
    builder.addPointPair(Math.cos(theta), Math.sin(theta));
  }

  return builder;
}

// ColGlow_CreateStarSmooth: `points` bow-ties, each built from two strips. The
// alternating scale pinches both of them in at the waist, leaving two long
// spikes per bow-tie.
const STAR_WAIST_SCALE = 0.03125;

// The order the body strip walks its four quarter-turns in — tip, waist, waist,
// tip — so that the two triangles between them cover the bow-tie rather than
// folding over it. `ColGlow_CreateStarSmooth` gets there by counting up and
// swapping 2 for 3 and 4 for 2 on the way.
const STAR_BODY_ORDER = [0, 1, 3, 2];

function buildStar(points: number): GlowStripBuilder {
  const builder = new GlowStripBuilder();

  const direction = (base: number, k: number): [number, number] => {
    const theta = base + (k * Math.PI) / 2.0;
    const scale = (k & 1) !== 0 ? STAR_WAIST_SCALE : 1.0;
    return [Math.cos(theta) * scale, Math.sin(theta) * scale];
  };

  for (let i = 0; i < points; i++) {
    const base = Math.PI / 2.0 + (i * Math.PI) / points;

    // The outline, five point pairs a quarter turn apart. On its own this is
    // only the rim: every one of its triangles has a vertex at the waist and
    // two along the same spike, so it collapses to a sliver along each spike
    // and rasterizes as a pair of thin edges.
    builder.startStrip();
    for (let k = 0; k <= 4; k++) builder.addPointPair(...direction(base, k));

    // The body, four vertices that are all class A. This is what actually fills
    // the two spikes in, and it is why a star reads as solid out to radius A
    // and only fades over the span from A to B.
    builder.startStrip();
    for (const k of STAR_BODY_ORDER)
      builder.addPoint(...direction(base, k), 1.0);
  }

  return builder;
}

interface GlowShapeBuffers {
  vertexBuffer: GfxBuffer;
  indexBuffer: GfxBuffer;
  vertexBufferDescriptors: GfxVertexBufferDescriptor[];
  indexBufferDescriptor: GfxIndexBufferDescriptor;
  indexCount: number;
}

export class GlowRenderer {
  private program: GfxProgram;
  private inputLayout: GfxInputLayout;
  private shapes = new Map<GlowShape, GlowShapeBuffers>();
  private megaStateFlags: Partial<GfxMegaStateDescriptor> = {
    cullMode: GfxCullMode.None,
    depthWrite: false,
    depthCompare: reverseDepthForCompareMode(GfxCompareMode.Less),
  };

  constructor(private cache: GfxRenderCache) {
    this.program = cache.createProgram(new GlowProgram());

    this.inputLayout = cache.createInputLayout({
      vertexAttributeDescriptors: [
        {
          location: GlowProgram.a_Direction,
          format: GfxFormat.F32_RG,
          bufferByteOffset: 0,
          bufferIndex: 0,
        },
        {
          location: GlowProgram.a_Class,
          format: GfxFormat.F32_R,
          bufferByteOffset: 2 * 4,
          bufferIndex: 0,
        },
      ],
      vertexBufferDescriptors: [
        {
          byteStride: VERTEX_STRIDE * 4,
          frequency: GfxVertexBufferFrequency.PerVertex,
        },
      ],
      indexBufferFormat: GfxFormat.U32_R,
    });

    // Glows are additive: the transparent end of each gradient contributes
    // nothing, the bright end sums into the framebuffer.
    setAttachmentStateSimple(this.megaStateFlags, {
      blendMode: GfxBlendMode.Add,
      blendSrcFactor: GfxBlendFactor.SrcAlpha,
      blendDstFactor: GfxBlendFactor.One,
    });
  }

  private getShape(shape: GlowShape): GlowShapeBuffers {
    let buffers = this.shapes.get(shape);
    if (buffers !== undefined) return buffers;

    const params = GLOW_SHAPE_PARAMS[shape];
    const builder = params.star
      ? buildStar(params.count)
      : buildRing(params.count);
    const { vertices, indices } = builder.finish();

    const device = this.cache.device;
    const vertexBuffer = createBufferFromData(
      device,
      GfxBufferUsage.Vertex,
      GfxBufferFrequencyHint.Static,
      vertices.buffer,
    );
    const indexBuffer = createBufferFromData(
      device,
      GfxBufferUsage.Index,
      GfxBufferFrequencyHint.Static,
      indices.buffer,
    );

    buffers = {
      vertexBuffer,
      indexBuffer,
      vertexBufferDescriptors: [{ buffer: vertexBuffer, byteOffset: 0 }],
      indexBufferDescriptor: { buffer: indexBuffer, byteOffset: 0 },
      indexCount: indices.length,
    };
    this.shapes.set(shape, buffers);
    return buffers;
  }

  // Glows render with their own program and state, so they get a template of
  // their own; the caller is expected to pop it once it is done submitting.
  public pushTemplate(
    renderInstManager: GfxRenderInstManager,
    viewerInput: ViewerRenderInput,
  ): void {
    const template = renderInstManager.pushTemplate();
    template.setBindingLayouts([{ numSamplers: 0, numUniformBuffers: 2 }]);
    template.setGfxProgram(this.program);
    template.setMegaStateFlags(this.megaStateFlags);

    const data = template.allocateUniformBufferF32(
      GlowProgram.ub_SceneParams,
      16 + 12,
    );
    const offs = fillMatrix4x4(data, 0, viewerInput.camera.projectionMatrix);
    fillMatrix4x3(data, offs, viewerInput.camera.viewMatrix);
  }

  public submitGlow(
    renderInstManager: GfxRenderInstManager,
    list: GfxRenderInstList,
    def: GlowDef,
  ): void {
    const shape = this.getShape(def.shape);

    const renderInst = renderInstManager.newRenderInst();
    renderInst.setVertexInput(
      this.inputLayout,
      shape.vertexBufferDescriptors,
      shape.indexBufferDescriptor,
    );
    renderInst.setDrawCount(shape.indexCount);

    const data = renderInst.allocateUniformBufferF32(
      GlowProgram.ub_GlowParams,
      4 * 4,
    );
    let offs = 0;
    offs += fillVec3v(data, offs, def.center);
    offs += fillVec4(
      data,
      offs,
      def.radiusA,
      def.radiusB,
      Math.cos(def.angle),
      Math.sin(def.angle),
    );
    offs += fillColor(data, offs, def.colorA);
    fillColor(data, offs, def.colorB);

    list.submitRenderInst(renderInst);
  }

  public destroy(device: GfxDevice): void {
    for (const shape of this.shapes.values()) {
      device.destroyBuffer(shape.vertexBuffer);
      device.destroyBuffer(shape.indexBuffer);
    }
  }
}
