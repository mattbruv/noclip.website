import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { DeviceProgram } from "../Program";

// Flat vertex-coloured geometry for the collision mesh out of the track's `gmd `
// resource. POINT_MODE expands each vertex into a screen-space quad so the
// vertex cloud stays legible at any distance.
export class CollisionProgram extends DeviceProgram {
  public static a_Position = 0;
  public static a_Color = 1;
  public static a_Offset = 2;

  public static ub_SceneParams = 0;

  constructor(pointMode: boolean) {
    super();
    this.setDefineBool("POINT_MODE", pointMode);
  }

  public override vert = `
${CollisionProgram.Common}

layout(location = ${CollisionProgram.a_Position}) in vec3 a_Position;
layout(location = ${CollisionProgram.a_Color}) in vec4 a_Color;
#if defined(POINT_MODE)
layout(location = ${CollisionProgram.a_Offset}) in vec2 a_Offset;
#endif

out vec4 v_Color;

void main() {
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(a_Position, 1.0f);
    v_Color = a_Color;

#if defined(POINT_MODE)
    // Fixed pixel size, applied after projection.
    gl_Position.xy += a_Offset * u_PointSize / u_ViewportSize * gl_Position.w;
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
};

#define u_ViewportSize (u_Misc.xy)
#define u_PointSize    (u_Misc.z)
`;
}
