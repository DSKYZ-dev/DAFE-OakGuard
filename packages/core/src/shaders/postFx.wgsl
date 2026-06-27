struct Uniforms {
  screenSize: vec2<f32>,
  time: f32,
  bloomStrength: f32,
  vignetteStrength: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

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
  let color = textureSample(inputTexture, textureSampler, in.uv);
  let vignette = 1.0 - uniforms.vignetteStrength * length(in.uv - 0.5) * 1.4;
  return vec4<f32>(color.rgb * vignette, color.a);
}
