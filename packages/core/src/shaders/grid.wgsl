struct Uniforms {
  projection: mat4x4<f32>,
  view: mat4x4<f32>,
  screenSize: vec2<f32>,
  gridSpacing: vec2<f32>,
  gridColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) alpha: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  let isHorizontal = instIdx < 10u;
  let lineIndex = instIdx % 10u;
  let linePos = f32(lineIndex) * uniforms.gridSpacing.x;

  var pos: vec2<f32>;
  if (isHorizontal) {
    pos = vec2<f32>(select(-1.0, 1.0, vertIdx == 1u), linePos);
  } else {
    pos = vec2<f32>(linePos, select(-1.0, 1.0, vertIdx == 1u));
  }

  var out: VertexOutput;
  out.position = uniforms.projection * uniforms.view * vec4<f32>(pos.x, 0.0, pos.y, 1.0);
  out.alpha = 0.3;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(uniforms.gridColor.rgb, uniforms.gridColor.a * in.alpha);
}
