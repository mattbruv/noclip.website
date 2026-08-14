/* @preserve The source code to this website is under the MIT license and can be found at https://github.com/magcius/noclip.website */

import {
  Viewer,
  SceneGfx,
  InitErrorCode,
  makeErrorUI,
  resizeCanvas,
  ViewerUpdateInfo,
  initializeViewerWebGL2,
  initializeViewerWebGPU,
} from "./viewer.js";

import * as Scenes_RumbleRacing from "./RumbleRacing/Scenes.js";

import { UI, Panel } from "./ui.js";
import { Camera, FPSCameraController } from "./Camera.js";
import { assertExists, assert } from "./util.js";
import { loadRustLib } from "./rustlib.js";
import { DataFetcher } from "./DataFetcher.js";
import { mat4 } from "gl-matrix";
import { GlobalSaveManager, SaveStateLocation } from "./SaveManager.js";
import { RenderStatistics } from "./RenderStatistics.js";
import { Color } from "./Color.js";
import { standardFullClearRenderPassDescriptor } from "./gfx/helpers/RenderGraphHelpers.js";

import {
  SceneDesc,
  SceneGroup,
  SceneContext,
  Destroyable,
} from "./SceneBase.js";
import { prepareFrameDebugOverlayCanvas2D } from "./DebugJunk.js";
import { downloadBlob } from "./DownloadUtils.js";
import { DataShare } from "./DataShare.js";
import InputManager from "./InputManager.js";
import { WebXRContext } from "./WebXR.js";
import { debugJunk } from "./DebugJunk.js";
import { IS_DEVELOPMENT } from "./BuildVersion.js";
import { GfxPlatform } from "./gfx/platform/GfxPlatform.js";
import { SaveState, SaveStateSerializer } from "./SaveState.js";
import ArrayBufferSlice from "./ArrayBufferSlice.js";

const sceneGroups: (string | SceneGroup)[] = [
  "PlayStation 2",
  Scenes_RumbleRacing.sceneGroup,
];

enum SaveStatesAction {
  Load,
  LoadDefault,
  Save,
  Delete,
}

class SceneDatabase {
  private sceneDescToGroup = new Map<SceneDesc, SceneGroup>();
  private sceneDescToId = new Map<SceneDesc, string>();
  private idToSceneDesc = new Map<string, SceneDesc>();

  public onchanged: (() => void) | null = null;

  constructor(public sceneGroups: (SceneGroup | string)[]) {
    for (const sceneGroup of sceneGroups) {
      if (typeof sceneGroup !== "object") continue;

      for (const sceneDesc of sceneGroup.sceneDescs)
        if (typeof sceneDesc === "object")
          this.addSceneDesc(sceneGroup, sceneDesc);

      if (sceneGroup.sceneIdMap !== undefined) {
        for (const [altSceneId, sceneId] of sceneGroup.sceneIdMap) {
          const altSceneDescId = `${sceneGroup.id}/${altSceneId}`;
          const sceneDescId = `${sceneGroup.id}/${sceneId}`;
          const sceneDesc = assertExists(this.idToSceneDesc.get(sceneDescId));
          this.idToSceneDesc.set(altSceneDescId, sceneDesc);
        }
      }
    }
  }

  private _makeSceneDescId(
    sceneGroup: SceneGroup,
    sceneDesc: SceneDesc,
  ): string {
    return `${sceneGroup.id}/${sceneDesc.id}`;
  }

  public getSceneDescId(sceneDesc: SceneDesc): string {
    return this.sceneDescToId.get(sceneDesc)!;
  }

  public getSceneDescGroup(sceneDesc: SceneDesc): SceneGroup {
    return this.sceneDescToGroup.get(sceneDesc)!;
  }

  public getSceneDescForId(sceneDescId: string): SceneDesc | null {
    return this.idToSceneDesc.get(sceneDescId) ?? null;
  }

  public getSceneDescForGroupAndId(
    sceneGroupId: string,
    sceneId: string,
  ): SceneDesc | null {
    const sceneDescId = `${sceneGroupId}/${sceneId}`;
    return this.getSceneDescForId(sceneDescId);
  }

  public addSceneDesc(sceneGroup: SceneGroup, sceneDesc: SceneDesc): void {
    assert(sceneGroup.sceneDescs.includes(sceneDesc));
    const sceneDescId = this._makeSceneDescId(sceneGroup, sceneDesc);
    this.sceneDescToGroup.set(sceneDesc, sceneGroup);
    this.sceneDescToId.set(sceneDesc, sceneDescId);
    this.idToSceneDesc.set(sceneDescId, sceneDesc);

    if (this.onchanged !== null) this.onchanged();
  }
}

type TimeState = {
  isPlaying: boolean;
  sceneTimeScale: number;
  sceneTime: number;
};

class AnimationLoop {
  public time: number = 0.0;
  public fpsLimit: number = -1;

  // Callback that will be called when we should render a frame.
  public onupdate!: () => void;

  // Call when a frame is requested from the underlying API.
  public frameRequested = (): void => {
    const newTime = window.performance.now();

    if (this.fpsLimit > 0) {
      const millisecondsPerFrame = 1000 / this.fpsLimit;
      const millisecondsSinceLastFrame = newTime - this.time;

      // Allow up to half a frame early.
      const minNextFrameTime = millisecondsPerFrame / 2;

      if (millisecondsSinceLastFrame < minNextFrameTime) return;
    }

    this.time = newTime;
    this.onupdate();
  };
}

class Main {
  public toplevel: HTMLElement;
  public canvas: HTMLCanvasElement;
  public viewer: Viewer;
  public ui: UI;
  public saveManager = GlobalSaveManager;

  private preferredPlatforms: GfxPlatform[] = [];

  private droppedFileGroup: SceneGroup;

  private sceneDatabase = new SceneDatabase(sceneGroups);

  private saveStateSerializer = new SaveStateSerializer();

  private currentSceneDesc: SceneDesc | null = null;

  private loadingSceneDesc: SceneDesc | null = null;
  private destroyablePool: Destroyable[] = [];
  private dataShare = new DataShare();
  private dataFetcher: DataFetcher;
  private lastUpdatedURLTimeSeconds: number = -1;

  private webXRContext: WebXRContext;
  private animationLoop = new AnimationLoop();

  private updateInfo: ViewerUpdateInfo = {
    time: 0.0,
    webXRContext: null,
  };

  public sceneTimeScale = 1.0;
  private isPlaying = false;
  private isFrameStep = false;

  public isEmbedMode = false;
  private pixelSize = 1;

  // Link to debugJunk so we can reference it from the DevTools.
  private debugJunk = debugJunk;

  constructor() {
    this.init();
  }

  public async init() {
    this.isEmbedMode = window.location.pathname === "/embed.html";

    this.toplevel = document.createElement("div");
    document.body.appendChild(this.toplevel);

    this.toplevel.ondragover = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
      this.ui.dragHighlight.style.display = "block";
      e.preventDefault();
    };
    this.toplevel.ondragleave = (e) => {
      this.ui.dragHighlight.style.display = "none";
      e.preventDefault();
    };
    this.toplevel.ondrop = this._onDrop.bind(this);

    await loadRustLib();

    this.initializePlatforms();
    if (!(await this.initializeViewer())) {
      return;
    }

    window.onresize = this._onResize.bind(this);

    this.animationLoop.onupdate = this.animationLoopOnUpdate.bind(this);

    this._makeUI();

    this.dataFetcher = new DataFetcher(this.ui.sceneSelect);
    await this.dataFetcher.init();

    this.droppedFileGroup = {
      id: "drops",
      name: "Dropped Files",
      sceneDescs: [],
    };
    sceneGroups.push("Other");
    sceneGroups.push(this.droppedFileGroup);

    this.ui.sceneSelect.setSceneDatabase(this.sceneDatabase);

    window.onhashchange = this._onHashChange.bind(this);

    if (this.currentSceneDesc === null) this._loadInitialStateFromHash();

    if (this.currentSceneDesc === null) {
      // Make the user choose a scene if there's nothing loaded by default...
      this.ui.sceneSelect.setExpanded(true);
    }

    this._onRequestAnimationFrame();
  }

  private _reloadCurrentSceneDesc(saveState: SaveState | null = null): void {
    if (saveState === null) saveState = this._getSceneSaveState();
    if (this.currentSceneDesc !== null)
      this._loadSceneDesc(this.currentSceneDesc, saveState, true);
  }

  private initializePlatforms(): void {
    let defaultPlatform = GfxPlatform.WebGL2;
    if (location.search.includes("webgpu"))
      defaultPlatform = GfxPlatform.WebGPU;

    this.preferredPlatforms = [];
    this.preferredPlatforms.push(defaultPlatform);
    this.preferredPlatforms.push(
      defaultPlatform === GfxPlatform.WebGPU
        ? GfxPlatform.WebGL2
        : GfxPlatform.WebGPU,
    );
  }

  private async initializeViewer(): Promise<boolean> {
    const platformsToTry = this.preferredPlatforms;
    assert(platformsToTry.length !== 0);

    // Create a new canvas.
    const canvas = document.createElement("canvas");
    const currentPlatform =
      this.viewer !== undefined
        ? this.viewer.gfxDevice.queryVendorInfo().platform
        : null;

    // No sense in trying to recreate the current platform.
    let error = InitErrorCode.SUCCESS;
    for (let i = 0; i < platformsToTry.length; i++) {
      const platform = platformsToTry[i];

      // Already good.
      if (platform === currentPlatform) return true;

      const ret =
        platform === GfxPlatform.WebGL2
          ? await initializeViewerWebGL2(canvas)
          : await initializeViewerWebGPU(canvas);

      error = ret.error;
      if (error !== InitErrorCode.SUCCESS) continue;

      // Success; initialize.
      if (this.canvas !== undefined) this.toplevel.removeChild(this.canvas);

      this.canvas = canvas;
      this.canvas.style.imageRendering = "pixelated";
      this.canvas.style.outline = "none";
      this.canvas.style.touchAction = "none";

      // Immediately resize the canvas.
      this._onResize();

      this.toplevel.appendChild(this.canvas);

      if (this.viewer !== undefined) this._destroyScene();

      assert(ret.viewer !== undefined);
      this.viewer = ret.viewer;

      this.webXRContext = new WebXRContext(
        this.viewer.gfxDevice,
        this.viewer.gfxSwapChain,
      );
      this.webXRContext.onframe = this.animationLoop.frameRequested;
      this.webXRContext.onsupportedchanged =
        this._syncWebXRSettingsVisible.bind(this);

      this.viewer.onstatistics = (statistics: RenderStatistics): void => {
        this.ui.statisticsPanel.addRenderStatistics(statistics);
      };
      this.viewer.oncamerachanged = (force: boolean) => {
        this._autoSaveState(force);
      };
      this.viewer.inputManager.ondraggingmodechanged = () => {
        this.ui.setDraggingMode(this.viewer.inputManager.getDraggingMode());
      };

      // HACK(jstpierre): Change the initialization here.
      if (this.ui !== undefined) {
        this.ui.setViewer(this.viewer);
        this._syncWebXRSettingsVisible();
      }

      return true;
    }

    assert(error !== InitErrorCode.SUCCESS);
    this.toplevel.appendChild(makeErrorUI(error));
    return false;
  }

  private async _swapPlatforms() {
    if (this.preferredPlatforms.length <= 1) return;

    const sceneSaveState = this._getSceneSaveState();

    this._destroyScene();

    // Wipe DataShare, since the data in there might be for the existing device/platform/
    this.dataShare.pruneOldObjects(this.viewer.gfxDevice, 0);

    // Shuffle around.
    const platform = this.preferredPlatforms.shift()!;
    this.preferredPlatforms.push(platform);
    await this.initializeViewer();

    this._reloadCurrentSceneDesc(sceneSaveState);
  }

  private setIsPlaying(v: boolean): void {
    if (this.isPlaying === v) return;

    this.isPlaying = v;
    this.ui.playPauseButton.setIsPlaying(v);

    if (IS_DEVELOPMENT)
      this._saveCurrentTimeState(this._getCurrentSceneDescId()!);
  }

  private _decodeHashString(hashString: string): [string, SaveState | null] {
    let sceneDescId: string = "",
      saveStateStr: string | null = null;
    const firstSemicolon = hashString.indexOf(";");
    if (firstSemicolon >= 0) {
      sceneDescId = hashString.slice(0, firstSemicolon);
      saveStateStr = hashString.slice(firstSemicolon + 1);
    } else {
      sceneDescId = hashString;
    }

    const saveState =
      saveStateStr !== null ? this._deserializeSaveState(saveStateStr) : null;
    return [sceneDescId, saveState];
  }

  private _decodeHash(): [string | null, SaveState | null] {
    const hash = window.location.hash;
    if (hash.startsWith("#")) {
      return this._decodeHashString(decodeURIComponent(hash.slice(1)));
    } else {
      return ["", null];
    }
  }

  private _onHashChange(): void {
    const [sceneDescId, sceneSaveState] = this._decodeHash();
    const sceneDesc =
      sceneDescId !== null
        ? this.sceneDatabase.getSceneDescForId(sceneDescId)
        : null;
    if (sceneDesc !== null) this._loadSceneDesc(sceneDesc, sceneSaveState);
  }

  private _loadInitialStateFromHash(): void {
    let [sceneDescId, sceneSaveState] = this._decodeHash();
    const sceneDesc =
      sceneDescId !== null
        ? this.sceneDatabase.getSceneDescForId(sceneDescId)
        : null;
    if (sceneDesc !== null) {
      // Load save slot 0 from session storage.
      if (sceneSaveState === null) {
        const key = this.saveManager.getSaveStateSlotKey(sceneDescId!, 0);
        sceneSaveState = this._deserializeSaveState(
          this.saveManager.loadState(key),
        );
      }
      this._loadSceneDesc(sceneDesc, sceneSaveState);
    }
  }

  private _exportSaveData() {
    const saveData = this.saveManager.export();
    const date = new Date();
    downloadBlob(
      `noclip_export_${date.toISOString()}.nclsp`,
      new Blob([saveData]),
    );
  }

  private _pickSaveStatesAction(inputManager: InputManager): SaveStatesAction {
    if (inputManager.isKeyDown("ShiftLeft")) return SaveStatesAction.Save;
    else if (inputManager.isKeyDown("AltLeft")) return SaveStatesAction.Delete;
    else return SaveStatesAction.Load;
  }

  private _checkKeyShortcuts() {
    const inputManager = this.viewer.inputManager;
    if (inputManager.isKeyDownEventTriggered("KeyZ")) this._toggleUI();
    if (inputManager.isKeyDownEventTriggered("KeyT"))
      this.ui.sceneSelect.expandAndFocus();
    for (let i = 1; i <= 9; i++) {
      if (inputManager.isKeyDownEventTriggered("Digit" + i)) {
        if (this.currentSceneDesc) {
          const key = this._getSaveStateSlotKey(i);
          const action = this._pickSaveStatesAction(inputManager);
          this.doSaveStatesAction(action, key);
        }
      }
    }

    if (inputManager.isKeyDownEventTriggered("Numpad3")) this._exportSaveData();
    if (inputManager.isKeyDownEventTriggered("Period"))
      this.setIsPlaying(!this.isPlaying);
    if (inputManager.isKeyDown("Comma")) {
      this.setIsPlaying(false);
      this.isFrameStep = true;
    }
    if (inputManager.isKeyDownEventTriggered("F4")) this._swapPlatforms();
    if (inputManager.isKeyDownEventTriggered("F9"))
      this._reloadCurrentSceneDesc();
  }

  private async _onWebXRStateRequested(state: boolean) {
    if (!this.webXRContext) return;

    if (state) {
      try {
        await this.webXRContext.start();
        if (!this.webXRContext.xrSession) {
          return;
        }
        mat4.getTranslation(
          this.viewer.xrCameraController.offset,
          this.viewer.camera.worldMatrix,
        );
        this.webXRContext.xrSession.addEventListener("end", () => {
          this.ui.toggleWebXRCheckbox(false);
        });
      } catch (e) {
        console.error("Failed to start XR");
        this.ui.toggleWebXRCheckbox(false);
      }
    } else {
      this.webXRContext.end();
    }
  }

  private animationLoopOnUpdate(): void {
    this._checkKeyShortcuts();

    prepareFrameDebugOverlayCanvas2D();

    if (!this.viewer.externalControl) {
      this.updateInfo.time = this.animationLoop.time;
      this.updateInfo.webXRContext =
        this.webXRContext.xrSession !== null ? this.webXRContext : null;

      let sceneTimeScale = this.sceneTimeScale;
      if (this.isFrameStep) {
        sceneTimeScale /= 4.0;
        this.isFrameStep = false;
      } else if (!this.isPlaying) {
        sceneTimeScale = 0.0;
      }

      this.viewer.sceneTimeScale = sceneTimeScale;
      this.viewer.update(this.updateInfo);
    }

    this.ui.update();
  }

  private _onRequestAnimationFrame = (): void => {
    if (this.webXRContext.xrSession !== null) {
      // Currently presenting to XR. Skip the canvas render.
    } else {
      this.animationLoop.frameRequested();
    }

    window.requestAnimationFrame(this._onRequestAnimationFrame);
  };

  private async _onDrop(e: DragEvent) {
    // this.ui.dragHighlight.style.display = "none";
    // if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    // e.preventDefault();
    // const transfer = e.dataTransfer;
    // const files = await traverseFileSystemDataTransfer(transfer);
    // const sceneDesc = new DroppedFileSceneDesc(files);
    // this.droppedFileGroup.sceneDescs.push(sceneDesc);
    // this.sceneDatabase.addSceneDesc(this.droppedFileGroup, sceneDesc);
    // this._loadSceneDesc(sceneDesc);
  }

  private _onResize() {
    resizeCanvas(
      this.canvas,
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio / this.pixelSize,
    );
  }

  private _getSceneSaveState(): SaveState {
    const saveState: SaveState = {
      cameraWorldMatrix: this.viewer.camera.worldMatrix,
      sceneData: null,
    };

    // TODO(jstpierre): Pass DataView into serializeSaveState
    if (this.viewer.scene !== null && this.viewer.scene.serializeSaveState) {
      const extraData = new ArrayBuffer(512);
      const byteLength = this.viewer.scene.serializeSaveState(extraData, 0);
      saveState.sceneData = new ArrayBufferSlice(extraData, 0, byteLength);
    }

    if (
      this.saveManager.loadSetting("SaveStateFovY", false) &&
      this.viewer.camera.fovY !== Camera.DefaultFovY
    ) {
      saveState.fovY = this.viewer.camera.fovY;
    }

    return saveState;
  }

  private _getSceneSaveStateStr() {
    const saveState = this._getSceneSaveState();
    return this.saveStateSerializer.serializeSaveState(saveState);
  }

  private _getCurrentSceneDescId() {
    if (this.currentSceneDesc === null) return null;

    return this.sceneDatabase.getSceneDescId(this.currentSceneDesc);
  }

  private _applyTimeState(timeState: TimeState): void {
    this.setIsPlaying(timeState.isPlaying);
    this.sceneTimeScale = timeState.sceneTimeScale;
    this.viewer.sceneTime = timeState.sceneTime;
  }

  private _loadTimeState(sceneDescId: string): TimeState | null {
    const timeStateKey = `TimeState/${sceneDescId}`;
    const timeStateStr = this.saveManager.loadStateFromLocation(
      timeStateKey,
      SaveStateLocation.SessionStorage,
    );
    if (!timeStateStr) return null;

    const timeState = JSON.parse(timeStateStr) as TimeState;
    return timeState;
  }

  private _saveCurrentTimeState(sceneDescId: string): void {
    const timeState: TimeState = {
      isPlaying: this.isPlaying,
      sceneTimeScale: this.sceneTimeScale,
      sceneTime: this.viewer.sceneTime,
    };
    const timeStateStr = JSON.stringify(timeState);
    const timeStateKey = `TimeState/${sceneDescId}`;
    this.saveManager.saveTemporaryState(timeStateKey, timeStateStr);
  }

  private _autoSaveState(forceUpdateURL: boolean = false) {
    if (this.currentSceneDesc === null) return;

    const sceneStateStr = this._getSceneSaveStateStr();
    const currentSceneDescId = this._getCurrentSceneDescId()!;
    const key = this.saveManager.getSaveStateSlotKey(currentSceneDescId, 0);
    this.saveManager.saveTemporaryState(key, sceneStateStr);

    if (IS_DEVELOPMENT) this._saveCurrentTimeState(currentSceneDescId);

    const saveState = `${currentSceneDescId};${sceneStateStr}`;
    this.ui.setShareSaveState(saveState);

    let shouldUpdateURL = forceUpdateURL;
    if (!shouldUpdateURL) {
      const timeSeconds = window.performance.now() / 1000;
      const secondsElapsedSinceLastUpdatedURL =
        timeSeconds - this.lastUpdatedURLTimeSeconds;

      if (secondsElapsedSinceLastUpdatedURL >= 2) shouldUpdateURL = true;
    }

    if (shouldUpdateURL) {
      window.history.replaceState("", document.title, `#${saveState}`);

      const timeSeconds = window.performance.now() / 1000;
      this.lastUpdatedURLTimeSeconds = timeSeconds;
    }
  }

  private _saveStateAndUpdateURL(): void {
    this._autoSaveState(true);
  }

  private _getSaveStateSlotKey(slotIndex: number): string {
    return this.saveManager.getSaveStateSlotKey(
      assertExists(this._getCurrentSceneDescId()),
      slotIndex,
    );
  }

  private _applySaveState(saveState: SaveState): void {
    mat4.copy(this.viewer.camera.worldMatrix, saveState.cameraWorldMatrix);

    if (
      this.viewer.scene !== null &&
      this.viewer.scene.deserializeSaveState &&
      saveState.sceneData !== null
    )
      this.viewer.scene.deserializeSaveState(saveState.sceneData);

    if (this.viewer.cameraController !== null)
      this.viewer.cameraController.cameraUpdateForced();

    if (saveState.fovY !== undefined) this.viewer.camera.fovY = saveState.fovY;
  }

  private _deserializeSaveState(str: string | null): SaveState | null {
    if (str === null) return null;

    const saveState: SaveState = {
      cameraWorldMatrix: mat4.create(),
      sceneData: null,
    };

    if (!this.saveStateSerializer.deserializeSaveState(saveState, str))
      return null;

    return saveState;
  }

  private _loadSaveStateString(str: string | null): boolean {
    const saveState = this._deserializeSaveState(str);
    if (saveState !== null) {
      this._applySaveState(saveState);
      return true;
    } else {
      return false;
    }
  }

  private _onSceneChanged(
    scene: SceneGfx,
    saveState: SaveState | null,
    timeState: TimeState | null,
  ): void {
    scene.onstatechanged = () => {
      this._saveStateAndUpdateURL();
    };

    let scenePanels: Panel[] = [];
    if (scene.createPanels) scenePanels = scene.createPanels();
    this.ui.setScenePanels(scenePanels);

    // Force time to play when loading a map.
    this.setIsPlaying(true);

    const sceneDescId = this._getCurrentSceneDescId()!;
    this.saveManager.setCurrentSceneDescId(sceneDescId);

    if (scene.createCameraController !== undefined)
      this.viewer.setCameraController(scene.createCameraController());
    if (this.viewer.cameraController === null)
      this.viewer.setCameraController(new FPSCameraController());

    if (saveState !== null) {
      this._applySaveState(saveState);
    } else {
      const camera = this.viewer.camera;

      const key = this.saveManager.getSaveStateSlotKey(sceneDescId, 1);
      const didLoadSaveState = this._loadSaveStateString(
        this.saveManager.loadState(key),
      );

      if (!didLoadSaveState) {
        if (scene.getDefaultWorldMatrix !== undefined)
          scene.getDefaultWorldMatrix(camera.worldMatrix);
        else mat4.identity(camera.worldMatrix);
      }
    }

    if (timeState !== null) this._applyTimeState(timeState);

    mat4.getTranslation(
      this.viewer.xrCameraController.offset,
      this.viewer.camera.worldMatrix,
    );

    this.ui.sceneChanged();
    this._saveStateAndUpdateURL();
  }

  private _onSceneDescSelected(sceneDesc: SceneDesc) {
    this._loadSceneDesc(sceneDesc);
  }

  private doSaveStatesAction(action: SaveStatesAction, key: string): void {
    if (action === SaveStatesAction.Save) {
      this.saveManager.saveState(key, this._getSceneSaveStateStr());
    } else if (action === SaveStatesAction.Delete) {
      this.saveManager.deleteState(key);
    } else if (action === SaveStatesAction.Load) {
      const state = this.saveManager.loadState(key);
      if (this._loadSaveStateString(state)) this._saveStateAndUpdateURL();
    } else if (action === SaveStatesAction.LoadDefault) {
      const state = this.saveManager.loadStateFromLocation(
        key,
        SaveStateLocation.Defaults,
      );
      if (this._loadSaveStateString(state)) this._saveStateAndUpdateURL();
    }
  }

  // How many previous scenes of data share contents to keep? Set it to 0 for leak checking.
  private get loadSceneDelta(): number {
    return this.saveManager.loadSetting("LoadSceneDelta", 1);
  }

  private set loadSceneDelta(v: number) {
    this.saveManager.saveSetting("LoadSceneDelta", v);
  }

  private _destroyScene(): void {
    const device = this.viewer.gfxDevice;

    // Tear down old scene.
    if (this.dataFetcher !== null) this.dataFetcher.abort();
    this.ui.destroyScene();
    if (this.viewer.scene && !this.destroyablePool.includes(this.viewer.scene))
      this.destroyablePool.push(this.viewer.scene);
    this.viewer.setScene(null);
    for (let i = 0; i < this.destroyablePool.length; i++)
      this.destroyablePool[i].destroy(device);
    this.destroyablePool.length = 0;

    this.ui.sceneChanged();
  }

  private _loadSceneDesc(
    sceneDesc: SceneDesc,
    saveState: SaveState | null = null,
    force: boolean = false,
  ): void {
    if (this.currentSceneDesc === sceneDesc && !force) {
      if (saveState !== null) this._applySaveState(saveState);
      return;
    }

    this._destroyScene();
    const sceneGroup = this.sceneDatabase.getSceneDescGroup(sceneDesc);

    // Unhide any hidden scene groups upon being loaded.
    if (sceneGroup.hidden) sceneGroup.hidden = false;
    if (sceneDesc.hidden) sceneDesc.hidden = false;

    this.currentSceneDesc = sceneDesc;
    this.ui.sceneSelect.setCurrentDesc(sceneGroup, this.currentSceneDesc);

    this.ui.sceneSelect.setProgress(0);

    const device = this.viewer.gfxDevice;
    const dataFetcher = this.dataFetcher;
    dataFetcher.reset();
    const dataShare = this.dataShare;
    const uiContainer: HTMLElement = document.createElement("div");
    this.ui.sceneUIContainer.appendChild(uiContainer);
    const destroyablePool: Destroyable[] = this.destroyablePool;
    const inputManager = this.viewer.inputManager;
    inputManager.reset();
    const viewerInput = this.viewer.viewerRenderInput;
    const sceneLoader = this;

    const timeState = IS_DEVELOPMENT
      ? this._loadTimeState(this.sceneDatabase.getSceneDescId(sceneDesc))
      : null;
    const initialSceneTime = timeState !== null ? timeState.sceneTime : 0;

    const context: SceneContext = {
      device,
      dataFetcher,
      dataShare,
      uiContainer,
      destroyablePool,
      inputManager,
      viewerInput,
      sceneLoader,
      initialSceneTime,
    };

    // We save loadSceneDelta's worth of old objects -- the idea being that if you're navigating between similar
    // scenes, we want to keep stuff in the data share (e.g. going between two Mario Kart tracks, you want to
    // keep the models for the same objects so we don't need to redownload them). Any objects that haven't been
    // touched since then will get eliminated eventually.
    this.dataShare.pruneOldObjects(device, this.loadSceneDelta);

    if (this.loadSceneDelta === 0) this.viewer.gfxDevice.checkForLeaks();

    this.dataShare.loadNewScene();
    window.dispatchEvent(new Event("loadNewScene"));

    this.loadingSceneDesc = sceneDesc;
    const promise = sceneDesc.createScene(device, context);

    if (promise === null) {
      console.error(
        `Cannot load ${sceneDesc.id}. Probably an unsupported file extension.`,
      );
      throw new Error("whoops");
    }

    promise.then((scene: SceneGfx) => {
      if (this.loadingSceneDesc === sceneDesc) {
        dataFetcher.setProgress();
        this.loadingSceneDesc = null;
        this.viewer.setScene(scene);
        this._onSceneChanged(scene, saveState, timeState);
      }
    });

    // Set window title.
    document.title = `${sceneDesc.name} - ${sceneGroup.name} - noclip`;
  }

  // SceneLoader API
  public loadSceneById(
    sceneGroup: string,
    sceneId: string,
    saveState: SaveState | null,
  ): void {
    const sceneDesc = assertExists(
      this.sceneDatabase.getSceneDescForGroupAndId(sceneGroup, sceneId),
    );
    this._loadSceneDesc(sceneDesc, saveState, true);
  }

  private _makeUI() {
    this.ui = new UI(this.viewer);
    this.ui.setEmbedMode(this.isEmbedMode);
    this.toplevel.appendChild(this.ui.elem);
    this.ui.sceneSelect.onscenedescselected =
      this._onSceneDescSelected.bind(this);
    this.ui.xrSettings.onWebXRStateRequested =
      this._onWebXRStateRequested.bind(this);
    this.ui.playPauseButton.onplaypause = this.setIsPlaying.bind(this);
    this._syncWebXRSettingsVisible();
  }

  private _syncWebXRSettingsVisible(): void {
    if (this.ui === undefined) return;
    this.ui.xrSettings.setVisible(this.webXRContext.isSupported);
  }

  private _toggleUI(visible?: boolean) {
    this.ui.toggleUI(visible);
  }

  // Hooks for people who want to mess with stuff.
  public getStandardClearColor(): Color {
    return standardFullClearRenderPassDescriptor.clearColor as Color;
  }

  public get scene() {
    return this.viewer.scene;
  }
}

// Declare a "main" object for easy access.
declare global {
  interface Window {
    main: Main;
  }
}

window.main = new Main();

// Debug utilities.
declare global {
  interface Window {
    debug: any;
    debugObj: any;
    gl: any;
  }
}
