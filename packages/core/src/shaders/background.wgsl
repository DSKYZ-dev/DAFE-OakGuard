struct Uniforms {
  resolution: vec2<f32>,
  time: f32,
  topColor: vec3<f32>,
  bottomColor: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertIdx: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertIdx], 0.0, 1.0);
  out.uv = positions[vertIdx] * 0.5 + 0.5;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let gradient = mix(uniforms.topColor, uniforms.bottomColor, in.uv.y);
  let glow = 0.02 / (distance(in.uv, vec2<f32>(0.2, 0.3)) * 2.0 + 0.5);
  return vec4<f32>(gradient + vec3<f32>(glow * 0.1), 1.0);
}
