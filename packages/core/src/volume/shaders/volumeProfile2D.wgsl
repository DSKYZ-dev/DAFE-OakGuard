struct VolumeBin {
  price: f32,
  volume: f32,
  buyVolume: f32,
  sellVolume: f32,
  barIndex: u32,
  tickCount: u32,
}

struct Uniforms {
  projection: mat4x4<f32>,
  maxVolume: f32,
  barWidth: f32,
  orientation: u32,
  bullColor: vec3<f32>,
  bearColor: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<VolumeBin>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  let bin = bins[instIdx];
  let normVol = bin.volume / uniforms.maxVolume;
  let ratio = bin.buyVolume / max(bin.volume, 0.001);

  let x = f32(bin.barIndex) * uniforms.barWidth;
  let y = bin.price;
  let vol = normVol * 20.0;

  let corners = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(vol, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(vol, 1.0),
  );

  let localPos = corners[vertIdx];
  let worldPos = vec3<f32>(x + localPos.x, y + localPos.y, 0.0);

  var out: VertexOutput;
  out.position = uniforms.projection * vec4<f32>(worldPos, 1.0);
  out.color = mix(uniforms.bearColor, uniforms.bullColor, ratio);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 0.85);
}
