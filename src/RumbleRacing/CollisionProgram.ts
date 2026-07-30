import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { DeviceProgram } from "../Program";

// Flat vertex-coloured geometry for the inspection layers built out of the
// track's `gmd ` and `Cnet` resources.
//
// POINT_MODE expands each vertex into a screen-space quad, and THICK_LINE_MODE
// expands each segment into a screen-space ribbon — GL line width is capped at
// one pixel, so paths have to be built out of triangles to read at any distance.
export const enum CollisionProgramMode {
  Mesh,
  Point,
  ThickLine,
}

export class CollisionProgram extends DeviceProgram {
  public static a_Position = 0;
  public static a_Color = 1;
  public static a_Offset = 2;
  public static a_Other = 3;

  public static ub_SceneParams = 0;

  constructor(mode: CollisionProgramMode) {
    super();
    this.setDefineBool("POINT_MODE", mode === CollisionProgramMode.Point);
    this.setDefineBool(
      "THICK_LINE_MODE",
      mode === CollisionProgramMode.ThickLine,
    );
  }

  public override vert = `
${CollisionProgram.Common}

layout(location = ${CollisionProgram.a_Position}) in vec3 a_Position;
layout(location = ${CollisionProgram.a_Color}) in vec4 a_Color;
#if defined(POINT_MODE) || defined(THICK_LINE_MODE)
layout(location = ${CollisionProgram.a_Offset}) in vec2 a_Offset;
#endif
#if defined(THICK_LINE_MODE)
layout(location = ${CollisionProgram.a_Other}) in vec3 a_Other;
#endif

out vec4 v_Color;

void main() {
    // These layers are coplanar with the geometry they describe, so they are
    // nudged a little way towards the camera in world space. That wins the depth
    // fight against the surface underneath while staying far too small to poke
    // through anything genuinely in front, so hills and walls still occlude.
    vec3 t_ToCamera = normalize(u_CameraPosition - a_Position);
    vec3 t_Position = a_Position + t_ToCamera * u_DepthOffset;

    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_Position, 1.0f);
    v_Color = a_Color;

#if defined(POINT_MODE)
    // Fixed pixel size, applied after projection.
    gl_Position.xy += a_Offset * u_PointSize / u_ViewportSize * gl_Position.w;
#endif

#if defined(THICK_LINE_MODE)
    // Offset along the segment's screen-space normal, so the ribbon keeps a
    // constant pixel width however far away it is.
    vec3 t_OtherToCamera = normalize(u_CameraPosition - a_Other);
    vec4 t_Other = UnpackMatrix(u_ClipFromWorld)
        * vec4(a_Other + t_OtherToCamera * u_DepthOffset, 1.0f);
    vec2 t_Here = (gl_Position.xy / gl_Position.w) * u_ViewportSize;
    vec2 t_There = (t_Other.xy / t_Other.w) * u_ViewportSize;

    vec2 t_Along = t_There - t_Here;
    float t_Length = length(t_Along);
    vec2 t_Normal = t_Length > 0.0001f
        ? vec2(-t_Along.y, t_Along.x) / t_Length
        : vec2(0.0f, 1.0f);

    gl_Position.xy += t_Normal * a_Offset.x * u_LineWidth / u_ViewportSize * gl_Position.w;
#endif
}
`;

  public override frag = `
${CollisionProgram.Common}

in vec4 v_Color;

void main() {
    gl_FragColor = v_Color;
}
`;

  public static Common = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ClipFromWorld;
    vec4 u_Misc;
    vec4 u_Camera;
};

#define u_ViewportSize   (u_Misc.xy)
#define u_PointSize      (u_Misc.z)
#define u_LineWidth      (u_Misc.z)
#define u_DepthOffset    (u_Misc.w)
#define u_CameraPosition (u_Camera.xyz)
`;
}
