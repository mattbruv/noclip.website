import {
  ActorData,
  ActorTransforms,
  ActorType,
  ExcludeInfo,
  GLOBAL_EXTRA_RESOURCE_INDICES,
  ObfData,
  POWERUP_MODEL_RESOURCE_INDEX,
  POWERUP_SHELL_RESOURCE_INDEX,
  processTrackFile,
  RumbleRacingTrackFile,
} from "./rumbleRacing";
import { mat4, vec3 } from "gl-matrix";
import { IS_DEVELOPMENT } from "../BuildVersion";
import {
  makeBackbufferDescSimple,
  standardFullClearRenderPassDescriptor,
} from "../gfx/helpers/RenderGraphHelpers";
import {
  fillMatrix4x3,
  fillMatrix4x4,
  fillVec4,
} from "../gfx/helpers/UniformBufferHelpers";
import { reverseDepthForCompareMode } from "../gfx/helpers/ReversedDepthHelpers";
import {
  GfxCullMode,
  GfxDevice,
  GfxMipFilterMode,
  GfxProgram,
  GfxSampler,
  GfxTexFilterMode,
  GfxTexture,
  GfxWrapMode,
  GfxBlendMode,
  GfxBlendFactor,
  GfxCompareMode,
  makeTextureDescriptor2D,
  GfxFormat,
} from "../gfx/platform/GfxPlatform";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import {
  GfxRenderInst,
  GfxRenderInstList,
} from "../gfx/render/GfxRenderInstManager";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxMegaStateDescriptor } from "../gfx/platform/GfxPlatform";
import { BlendMode } from "./asset/o3d/geometry";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { SceneGfx, ViewerRenderInput } from "../viewer";
import * as UI from "../ui";
import { FakeTextureHolder } from "../TextureHolder";
import { DrawBatch, MergedGeometry, O3DGeometry } from "./Geometry";
import { TrackProgram } from "./TrackProgram";
import { GlowDef, GlowRenderer, GlowShape, glowColorFromRGBA32 } from "./Glow";

const pathBase = `RumbleRacing`;
const GLOBAL_SCALE = 300.0; // this feels the best
const SOLID_PASS_ALPHA_REF = 0.99;

// powerUp_Simulate spins the inner pickup a quarter turn per second about the
// vertical axis, overwriting whatever terrain-aligned basis it was spawned with.
const POWERUP_SPIN_RATE = Math.PI / 2.0;

// The shell gets three separately accumulating angles instead, which
// mat44flt_EulerAngles turns into a rotation about Y, X and Z respectively. The
// order the three are composed in is the one part of this not read out of the
// VU0 macro ops, and at 839 deg/sec on the last axis it does not read.
const POWERUP_SHELL_RATE_Y = 1.2566371; // 72 deg/sec
const POWERUP_SHELL_RATE_X = 1.8849558; // 108 deg/sec
const POWERUP_SHELL_RATE_Z = 14.639822; // 839 deg/sec

// SFX_InitPowerup sizes the glow off whichever of the two models is larger,
// falling back to the inner one when the shell is absent.
const POWERUP_GLOW_RADIUS_SCALE = 0.9;

// The three glow definitions SFX_RenderPowerup appends every frame: two rings
// that fade out towards the middle and the rim, plus a star flare.
const POWERUP_GLOW_CLEAR = glowColorFromRGBA32(0x00000000);
const POWERUP_GLOW_RING = glowColorFromRGBA32(0xa8a8ff60);
const POWERUP_GLOW_STAR = glowColorFromRGBA32(0xb8b8ff80);

interface TrackGeometryGroup {
  geometry: MergedGeometry;
  visible: boolean;
  label: string;
}

interface PowerUp {
  // Position and scale only: the spin is applied at render time.
  baseMatrix: mat4;
  glowCenter: vec3;
  glowRadius: number;
  glowDefs: GlowDef[];
}

const scratchMatrix = mat4.create();
const scratchShellMatrix = mat4.create();

class RumbleRacingScene implements SceneGfx {
  private renderHelper: GfxRenderHelper;
  private renderInstList = new GfxRenderInstList(null);
  private blendedRenderInstList = new GfxRenderInstList(null);
  private trackGroups: TrackGeometryGroup[] = [];
  private o3dGeometries: Map<number, O3DGeometry> = new Map();
  private programCache = new Map<number, GfxProgram>();
  private linearSampler: GfxSampler;
  private textureMap = new Map<number, GfxTexture>();
  private showActors: boolean = true;
  private showPowerUps: boolean = true;
  private showPowerUpGlow: boolean = true;
  private wireframe: boolean = false;
  private showVertexColors: boolean = true;
  private showTextures: boolean = true;

  public textureHolder = new FakeTextureHolder([]);
  private actorMatrices = new Map<number, mat4>();
  private glowRenderer: GlowRenderer;
  private powerUps: PowerUp[] = [];
  // Model-space offset of the pickup's bounding-sphere center, which is what the
  // glow primitives are centered on rather than the actor's origin.
  private powerUpGlowOffset = vec3.create();

  constructor(
    private sceneContext: SceneContext,
    private trackFile: RumbleRacingTrackFile,
    private actorTrans: ActorTransforms,
    private exclude: ExcludeInfo,
  ) {
    this.renderHelper = new GfxRenderHelper(sceneContext.device, sceneContext);
    const cache = this.renderHelper.renderCache;

    this.setActorTransforms();

    for (const actor of this.trackFile.actors) {
      this.actorMatrices.set(
        actor.resourceIndex,
        buildActorMatrix(actor, GLOBAL_SCALE),
      );
    }

    this.buildTrackGroups(cache);

    for (let i = 0; i < this.trackFile.o3ds.length; i++) {
      const o3d = this.trackFile.o3ds[i];
      this.o3dGeometries.set(
        o3d.resourceIndex,
        new O3DGeometry(cache, o3d, this.exclude),
      );
    }

    this.glowRenderer = new GlowRenderer(cache);
    this.buildPowerUps();

    this.linearSampler = cache.createSampler({
      minFilter: GfxTexFilterMode.Bilinear,
      magFilter: GfxTexFilterMode.Bilinear,
      mipFilter: GfxMipFilterMode.Linear,
      wrapS: GfxWrapMode.Repeat,
      wrapT: GfxWrapMode.Repeat,
    });

    this.handleTextures();
    this.resolveBatchTextures();
  }

  private buildTrackGroups(cache: GfxRenderCache): void {
    const track: ObfData[] = [];
    const panorama: ObfData[] = [];

    for (const obf of this.trackFile.obfs) {
      if (obf.name.includes("TRACKPAN")) {
        panorama.push(obf);
      } else {
        track.push(obf);
      }
    }

    this.trackGroups.push({
      geometry: new MergedGeometry(cache, track, this.exclude),
      visible: true,
      label: "Track",
    });

    this.trackGroups.push({
      geometry: new MergedGeometry(cache, panorama, this.exclude),
      visible: true,
      label: "Track Panorama",
    });
  }

  // Power-up pickups are drawn in three layers: the spinning PU_INNER model, the
  // PU_OUTER shell tumbling around it, and the glow primitives
  // SFX_RenderPowerup hands to the ColGlow billboard system.
  private buildPowerUps(): void {
    const findModel = (resourceIndex: number) =>
      this.trackFile.o3ds.find((o3d) => o3d.resourceIndex === resourceIndex);
    const model = findModel(POWERUP_MODEL_RESOURCE_INDEX);
    const shell = findModel(POWERUP_SHELL_RESOURCE_INDEX);

    const innerSphere = model?.boundingSphere ?? null;
    const shellSphere = shell?.boundingSphere ?? null;

    // The glow hangs off the inner model's bounding sphere, but it is sized from
    // whichever model is larger.
    if (innerSphere !== null)
      vec3.copy(this.powerUpGlowOffset, innerSphere.center);

    const innerRadius = innerSphere?.radius ?? 0.0;
    const radius =
      (shellSphere !== null
        ? POWERUP_GLOW_RADIUS_SCALE * Math.max(innerRadius, shellSphere.radius)
        : innerRadius) * GLOBAL_SCALE;

    let missingTransforms = 0;

    for (const actor of this.trackFile.actors) {
      if (actor.actorType !== ActorType.PowerUp) continue;

      // Pickups hover above the terrain, and the height only exists at runtime,
      // so it has to come out of the pre-processed transform data.
      if (actor.transform === undefined) {
        missingTransforms++;
        continue;
      }

      const baseMatrix = this.actorMatrices.get(actor.resourceIndex)!;
      const glowCenter = vec3.create();

      const glowDefs: GlowDef[] = [
        {
          center: glowCenter,
          colorA: POWERUP_GLOW_CLEAR,
          colorB: POWERUP_GLOW_RING,
          radiusA: 0.0,
          radiusB: radius,
          angle: 0.0,
          shape: GlowShape.Ring24,
        },
        {
          center: glowCenter,
          colorA: POWERUP_GLOW_CLEAR,
          colorB: POWERUP_GLOW_RING,
          radiusA: 1.1 * radius,
          radiusB: radius,
          angle: 0.0,
          shape: GlowShape.Ring24,
        },
        {
          center: glowCenter,
          colorA: POWERUP_GLOW_CLEAR,
          colorB: POWERUP_GLOW_STAR,
          radiusA: 3.0 * radius,
          radiusB: 0.0,
          angle: Math.PI / 2.0,
          shape: GlowShape.Star1,
        },
      ];

      this.powerUps.push({
        baseMatrix,
        glowCenter,
        glowRadius: radius,
        glowDefs,
      });
    }

    if (missingTransforms > 0)
      console.warn(
        `RumbleRacing: no transform data for ${missingTransforms} power-up(s); run tools/actorTransforms.ts to regenerate it`,
      );
  }

  private resolveBatchTextures(): void {
    const resolve = (geometry: MergedGeometry) => {
      geometry.batches = geometry.batches.filter((batch) => {
        const gfxTexture = this.textureMap.get(batch.textureId);
        if (gfxTexture === undefined) return false;
        batch.samplerBindings = [
          { gfxTexture, gfxSampler: this.linearSampler },
        ];
        return true;
      });
    };

    for (const group of this.trackGroups) resolve(group.geometry);
    for (const o3dGeom of this.o3dGeometries.values())
      for (const frame of o3dGeom.frames) resolve(frame);
  }

  private setActorTransforms() {
    for (const actor of this.trackFile.actors) {
      if (this.actorTrans && this.actorTrans[actor.resourceIndex]) {
        actor.transform = this.actorTrans[actor.resourceIndex];
        // console.log("Set trans for", actor.Name, actor.transform);
      }
      // else {
      // console.log("no trans data for ", actor.Name, actor.ResourceIndex);
      // }
    }
  }

  private handleTextures() {
    const device = this.renderHelper.device;

    for (const texture of this.trackFile.textures.sort(
      (a, b) => a.textureId - b.textureId,
    )) {
      const tex = device.createTexture(
        makeTextureDescriptor2D(
          GfxFormat.U8_RGBA_NORM,
          texture.width,
          texture.height,
          texture.textureData.length,
        ),
      );

      device.uploadTextureData(tex, 0, texture.textureData);
      device.setResourceName(tex, `texture_${texture.textureId}`);

      this.textureMap.set(texture.textureId, tex);
      this.textureHolder.viewerTextures.push({ gfxTexture: tex });
    }

    this.textureHolder.onnewtextures();
  }

  private getProgram(hasVertexColors: boolean, alphaTest: boolean): GfxProgram {
    const ignoreVertexColors = hasVertexColors && !this.showVertexColors;
    const ignoreTextures = !this.showTextures;

    const key =
      (hasVertexColors ? 1 : 0) |
      (ignoreVertexColors ? 2 : 0) |
      (ignoreTextures ? 4 : 0) |
      (alphaTest ? 8 : 0);

    let program = this.programCache.get(key);
    if (program === undefined) {
      program = this.renderHelper.renderCache.createProgram(
        new TrackProgram(
          hasVertexColors,
          alphaTest,
          ignoreVertexColors,
          ignoreTextures,
        ),
      );
      this.programCache.set(key, program);
    }
    return program;
  }

  private fillSceneParams(
    template: GfxRenderInst,
    viewerInput: ViewerRenderInput,
  ): void {
    const data = template.allocateUniformBufferF32(
      TrackProgram.ub_SceneParams,
      16,
    );
    fillMatrix4x4(data, 0, viewerInput.camera.clipFromWorldMatrix);
  }

  private newBatchInst(
    geometry: MergedGeometry,
    batch: DrawBatch,
    modelMatrix: mat4,
    alphaTestRef: number,
  ): GfxRenderInst {
    const renderInst = this.renderHelper.renderInstManager.newRenderInst();
    renderInst.setGfxProgram(
      this.getProgram(batch.hasVertexColors, alphaTestRef > 0.0),
    );
    renderInst.setSamplerBindings(0, batch.samplerBindings!);
    renderInst.setVertexInput(
      geometry.inputLayout,
      batch.vertexBufferDescriptors,
      batch.indexBufferDescriptor,
    );
    renderInst.setDrawCount(batch.indexCount);

    const meshParams = renderInst.allocateUniformBufferF32(
      TrackProgram.ub_MeshParams,
      16,
    );
    const offs = fillMatrix4x3(meshParams, 0, modelMatrix);
    fillVec4(meshParams, offs, alphaTestRef, 0, 0, 0);

    return renderInst;
  }

  private submitBatches(geometry: MergedGeometry, modelMatrix: mat4): void {
    for (const batch of geometry.batches) {
      if (batch.blendMode === BlendMode.None) {
        this.renderInstList.submitRenderInst(
          this.newBatchInst(geometry, batch, modelMatrix, 0.0),
        );
        continue;
      }

      this.renderInstList.submitRenderInst(
        this.newBatchInst(geometry, batch, modelMatrix, SOLID_PASS_ALPHA_REF),
      );

      const soft = this.newBatchInst(geometry, batch, modelMatrix, 0.0);
      soft.setMegaStateFlags({
        depthWrite: false,
        depthCompare: reverseDepthForCompareMode(GfxCompareMode.Less),
      });
      const megaState: Partial<GfxMegaStateDescriptor> = {};
      setAttachmentStateSimple(megaState, {
        blendMode: GfxBlendMode.Add,
        blendSrcFactor: GfxBlendFactor.SrcAlpha,
        blendDstFactor:
          batch.blendMode === BlendMode.Additive
            ? GfxBlendFactor.One
            : GfxBlendFactor.OneMinusSrcAlpha,
      });
      soft.setMegaStateFlags(megaState);
      this.blendedRenderInstList.submitRenderInst(soft);
    }
  }

  private renderMap(viewerInput: ViewerRenderInput): void {
    const template = this.renderHelper.renderInstManager.pushTemplate();
    template.setMegaStateFlags({ cullMode: GfxCullMode.None });

    const trackMatrix = mat4.create();
    mat4.scale(trackMatrix, trackMatrix, [
      GLOBAL_SCALE,
      GLOBAL_SCALE,
      GLOBAL_SCALE,
    ]);

    for (const group of this.trackGroups) {
      if (!group.visible) continue;
      this.submitBatches(group.geometry, trackMatrix);
    }

    if (this.showActors) {
      for (const actor of this.trackFile.actors) {
        if (actor.actorType === ActorType.PowerUp) continue;

        const o3dGeom = this.o3dGeometries.get(actor.o3dResourceIndex);
        if (!o3dGeom) continue;

        const frame = o3dGeom.frames[o3dGeom.animationFrame];
        if (frame === undefined) continue;

        this.submitBatches(frame, this.actorMatrices.get(actor.resourceIndex)!);
      }
    }

    if (this.showPowerUps) this.renderPowerUpModels(viewerInput);

    this.renderHelper.renderInstManager.popTemplate();

    if (this.showPowerUps && this.showPowerUpGlow)
      this.renderPowerUpGlows(viewerInput);
  }

  private powerUpMatrix(
    powerUp: PowerUp,
    viewerInput: ViewerRenderInput,
  ): mat4 {
    const yaw = POWERUP_SPIN_RATE * (viewerInput.time / 1000.0);
    mat4.rotateY(scratchMatrix, powerUp.baseMatrix, yaw);
    return scratchMatrix;
  }

  private powerUpShellMatrix(
    powerUp: PowerUp,
    viewerInput: ViewerRenderInput,
  ): mat4 {
    const seconds = viewerInput.time / 1000.0;
    mat4.rotateY(
      scratchShellMatrix,
      powerUp.baseMatrix,
      POWERUP_SHELL_RATE_Y * seconds,
    );
    mat4.rotateX(
      scratchShellMatrix,
      scratchShellMatrix,
      POWERUP_SHELL_RATE_X * seconds,
    );
    mat4.rotateZ(
      scratchShellMatrix,
      scratchShellMatrix,
      POWERUP_SHELL_RATE_Z * seconds,
    );
    return scratchShellMatrix;
  }

  private renderPowerUpModels(viewerInput: ViewerRenderInput): void {
    const inner = this.o3dGeometries.get(POWERUP_MODEL_RESOURCE_INDEX)
      ?.frames[0];
    const shell = this.o3dGeometries.get(POWERUP_SHELL_RESOURCE_INDEX)
      ?.frames[0];

    for (const powerUp of this.powerUps) {
      if (inner !== undefined)
        this.submitBatches(inner, this.powerUpMatrix(powerUp, viewerInput));
      if (shell !== undefined)
        this.submitBatches(
          shell,
          this.powerUpShellMatrix(powerUp, viewerInput),
        );
    }
  }

  private renderPowerUpGlows(viewerInput: ViewerRenderInput): void {
    const renderInstManager = this.renderHelper.renderInstManager;
    this.glowRenderer.pushTemplate(renderInstManager, viewerInput);

    for (const powerUp of this.powerUps) {
      if (powerUp.glowRadius <= 0.0) continue;

      vec3.transformMat4(
        powerUp.glowCenter,
        this.powerUpGlowOffset,
        this.powerUpMatrix(powerUp, viewerInput),
      );

      for (const def of powerUp.glowDefs)
        this.glowRenderer.submitGlow(
          renderInstManager,
          this.blendedRenderInstList,
          def,
        );
    }

    renderInstManager.popTemplate();
  }

  private updateAnimations(viewerInput: ViewerRenderInput): void {
    const halfSecondIndex = Math.floor(viewerInput.time / 100);
    for (const [, o3dGeom] of this.o3dGeometries) {
      if (o3dGeom.isAnimated && o3dGeom.frames.length > 0) {
        o3dGeom.animationFrame = halfSecondIndex % o3dGeom.frames.length;
      }
    }
  }

  public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
    this.updateAnimations(viewerInput);

    this.renderHelper.debugDraw.beginFrame(
      viewerInput.camera.projectionMatrix,
      viewerInput.camera.viewMatrix,
      viewerInput.backbufferWidth,
      viewerInput.backbufferHeight,
    );

    const template = this.renderHelper.pushTemplateRenderInst();
    template.setBindingLayouts([{ numSamplers: 1, numUniformBuffers: 2 }]);

    if (this.wireframe) template.setMegaStateFlags({ wireframe: true });

    this.fillSceneParams(template, viewerInput);

    this.renderMap(viewerInput);

    const builder = this.renderHelper.renderGraph.newGraphBuilder();

    const mainColorDesc = makeBackbufferDescSimple(
      GfxrAttachmentSlot.Color0,
      viewerInput,
      standardFullClearRenderPassDescriptor,
    );
    const mainDepthDesc = makeBackbufferDescSimple(
      GfxrAttachmentSlot.DepthStencil,
      viewerInput,
      standardFullClearRenderPassDescriptor,
    );

    const mainColorTargetID = builder.createRenderTargetID(
      mainColorDesc,
      "Main Color",
    );
    const mainDepthTargetID = builder.createRenderTargetID(
      mainDepthDesc,
      "Main Depth",
    );

    builder.pushPass((pass) => {
      pass.setDebugName("Opaque Objects");
      pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
      pass.attachRenderTargetID(
        GfxrAttachmentSlot.DepthStencil,
        mainDepthTargetID,
      );
      pass.exec((passRenderer) => {
        this.renderInstList.drawOnPassRenderer(
          this.renderHelper.renderCache,
          passRenderer,
        );
        this.blendedRenderInstList.drawOnPassRenderer(
          this.renderHelper.renderCache,
          passRenderer,
        );
      });
    });

    this.renderHelper.renderInstManager.popTemplate();
    this.renderHelper.debugDraw.pushPasses(
      builder,
      mainColorTargetID,
      mainDepthTargetID,
    );
    this.renderHelper.antialiasingSupport.pushPasses(
      builder,
      viewerInput,
      mainColorTargetID,
    );

    builder.resolveRenderTargetToExternalTexture(
      mainColorTargetID,
      viewerInput.onscreenTexture,
    );

    this.renderHelper.prepareToRender();
    builder.execute();
  }

  public createPanels(): UI.Panel[] {
    const trackGeometryPanel = new UI.Panel();
    trackGeometryPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
    trackGeometryPanel.setTitle(UI.LAYER_ICON, "Track Geometry");

    const showActorsCheckbox = new UI.Checkbox("Actors", this.showActors);
    showActorsCheckbox.onchanged = () => {
      this.showActors = showActorsCheckbox.checked;
    };

    trackGeometryPanel.contents.appendChild(showActorsCheckbox.elem);

    const showPowerUpsCheckbox = new UI.Checkbox(
      "Power-Ups",
      this.showPowerUps,
    );
    showPowerUpsCheckbox.onchanged = () => {
      this.showPowerUps = showPowerUpsCheckbox.checked;
    };

    trackGeometryPanel.contents.appendChild(showPowerUpsCheckbox.elem);

    const showPowerUpGlowCheckbox = new UI.Checkbox(
      "Power-Up Glow",
      this.showPowerUpGlow,
    );
    showPowerUpGlowCheckbox.onchanged = () => {
      this.showPowerUpGlow = showPowerUpGlowCheckbox.checked;
    };

    trackGeometryPanel.contents.appendChild(showPowerUpGlowCheckbox.elem);

    for (const group of this.trackGroups) {
      const checkbox = new UI.Checkbox(group.label, group.visible);
      checkbox.onchanged = () => {
        group.visible = checkbox.checked;
      };
      trackGeometryPanel.contents.appendChild(checkbox.elem);
    }

    const renderSettingsPanel = new UI.Panel();
    renderSettingsPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
    renderSettingsPanel.setTitle(UI.RENDER_HACKS_ICON, "Render Settings");

    const showVertexColorsCheckbox = new UI.Checkbox(
      "Vertex Colors",
      this.showVertexColors,
    );
    showVertexColorsCheckbox.onchanged = () => {
      this.showVertexColors = showVertexColorsCheckbox.checked;
    };

    renderSettingsPanel.contents.appendChild(showVertexColorsCheckbox.elem);

    const showTexturesCheckbox = new UI.Checkbox("Textures", this.showTextures);
    showTexturesCheckbox.onchanged = () => {
      this.showTextures = showTexturesCheckbox.checked;
    };

    renderSettingsPanel.contents.appendChild(showTexturesCheckbox.elem);

    if (this.renderHelper.device.queryLimits().wireframeSupported) {
      const wireframe = new UI.Checkbox("Wireframe", false);
      wireframe.onchanged = () => {
        const v = wireframe.checked;
        this.wireframe = v;
      };
      renderSettingsPanel.contents.appendChild(wireframe.elem);
    }

    return [trackGeometryPanel, renderSettingsPanel];
  }

  public destroy(device: GfxDevice): void {
    this.renderHelper.destroy();
    this.glowRenderer.destroy(device);

    for (const group of this.trackGroups) group.geometry.destroy(device);

    for (const [, o3dGeom] of this.o3dGeometries) {
      o3dGeom.destroy(device);
    }

    for (const vt of this.textureHolder.viewerTextures) {
      if (vt.gfxTexture !== null) device.destroyTexture(vt.gfxTexture);
    }
  }
}

function buildActorMatrix(actor: ActorData, globalScale: number): mat4 {
  const m = mat4.create();

  if (actor.transform) {
    const t = actor.transform;

    m[0] = t[0][0];
    m[1] = t[0][1];
    m[2] = t[0][2];
    m[3] = 0.0;

    m[4] = t[1][0];
    m[5] = t[1][1];
    m[6] = t[1][2];
    m[7] = 0.0;

    m[8] = t[2][0];
    m[9] = t[2][1];
    m[10] = t[2][2];
    m[11] = 0.0;

    m[12] = t[3][0] * globalScale;
    m[13] = t[3][1] * globalScale;
    m[14] = t[3][2] * globalScale;
    m[15] = 1.0;

    mat4.scale(m, m, [globalScale, globalScale, globalScale]);

    return m;
  }

  // Actors the game does not spawn at load — easter eggs, the stopwatch pickups,
  // The Gauntlet's car wrecks — have no runtime transform to scrape, so fall back
  // to the position the track file authored. That leaves the basis unknown, but
  // it beats stacking them all on the world origin.
  mat4.fromTranslation(m, [
    actor.x * globalScale,
    actor.y * globalScale,
    actor.z * globalScale,
  ]);
  mat4.scale(m, m, [globalScale, globalScale, globalScale]);
  return m;
}

class RumbleRacingSceneDesc implements SceneDesc {
  constructor(
    public internalName: string,
    public id: string,
    public name: string,
    public exclude: ExcludeInfo,
  ) {}

  public async createScene(
    device: GfxDevice,
    sceneContext: SceneContext,
  ): Promise<SceneGfx> {
    const folder = this.internalName.slice(0, 2);

    const [trackBlob, actorBlob] = await Promise.all([
      sceneContext.dataFetcher.fetchData(
        `${pathBase}/DATA/LOC${folder}/${this.internalName}.TRK`,
      ),
      sceneContext.dataFetcher.fetchData(
        `${pathBase}/json/${this.internalName}.json`,
      ),
    ]);

    const decoder = new TextDecoder("utf-8");
    const actorTrans = JSON.parse(
      decoder.decode(actorBlob.arrayBuffer),
    ) as unknown as ActorTransforms;

    const trackData: RumbleRacingTrackFile = processTrackFile(
      new Uint8Array(trackBlob.arrayBuffer),
      false,
    );

    const shared =
      await sceneContext.dataShare.ensureObject<RumbleRacingShared>(
        `${pathBase}/shared`,
        async () => {
          const data = await sceneContext.dataFetcher.fetchData(
            `${pathBase}/DATA/GLBLDATA.TRK`,
          );

          const globalData: RumbleRacingTrackFile = processTrackFile(
            new Uint8Array(data.arrayBuffer),
            true,
          );
          return {
            globalTrackFile: globalData,
            destroy(_device) {},
          };
        },
      );

    const existingTexIds = new Set(trackData.textures.map((x) => x.textureId));
    trackData.textures.push(
      ...shared.globalTrackFile.textures.filter(
        (t) => !existingTexIds.has(t.textureId),
      ),
    );

    // The pickup models live in the global file rather than in the track.
    const existingO3DIds = new Set(trackData.o3ds.map((x) => x.resourceIndex));
    trackData.o3ds.push(
      ...shared.globalTrackFile.o3ds.filter(
        (o3d) =>
          GLOBAL_EXTRA_RESOURCE_INDICES.has(o3d.resourceIndex) &&
          !existingO3DIds.has(o3d.resourceIndex),
      ),
    );

    return new RumbleRacingScene(
      sceneContext,
      trackData,
      actorTrans,
      this.exclude,
    );
  }
}

export const sceneGroup: SceneGroup = {
  id: "RumbleRacing",
  name: "Rumble Racing",
  sceneDescs: [
    "Beach Blast",
    new RumbleRacingSceneDesc("BB1", "SunBurn", "Sun Burn", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("BB2", "SurfAndTurf", "Surf And Turf", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    "Bad Lands",
    new RumbleRacingSceneDesc("BL1", "SoRefined", "So Refined", {
      textureIds: new Set([1584]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("BL2", "CoalCuts", "Coal Cuts", {
      // seems like there are no tornado clouds in this level for some reason?
    }),
    "Daytona",
    new RumbleRacingSceneDesc("DA1", "FlipOut", "Flip Out", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("DA2", "TheGauntlet", "The Gauntlet", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("DA3", "WildKingdom", "Wild Kingdom", {
      // no clouds in wild kingdom
    }),
    "Joke Tracks",
    new RumbleRacingSceneDesc("JT1", "CircusMinimus", "Circus Minimus", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("JT2", "OuterLimits", "Outer Limits", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    "Mountain Air",
    new RumbleRacingSceneDesc("MA1", "PassingThrough", "Passing Through", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("MA2", "FallsDown", "Falls Down", {
      textureIds: new Set([1584]), // tornado clouds
    }),
    "Metropolis",
    new RumbleRacingSceneDesc("MP1", "TouchAndGo", "Touch And Go", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("MP2", "CarGo", "Car Go", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    "Southern Exposure",
    new RumbleRacingSceneDesc("SE1", "TrueGrits", "True Grits", {
      textureIds: new Set([3120]), // tornado clouds
    }),
    new RumbleRacingSceneDesc("SE2", "OverEasy", "Over Easy", {
      textureIds: new Set([3120]), // tornado clouds
    }),
  ],
  hidden: !IS_DEVELOPMENT,
};

interface RumbleRacingShared {
  globalTrackFile: RumbleRacingTrackFile;
  destroy(device: GfxDevice): void;
}
