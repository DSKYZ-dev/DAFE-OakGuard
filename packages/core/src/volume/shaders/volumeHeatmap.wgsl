struct VolumeBin {
  price: f32,
  volume: f32,
  buyVolume: f32,
  sellVolume: f32,
  barIndex: u32,
  tickCount: u32,
}

struct Uniforms {
  viewProjection: mat4x4<f32>,
  maxVolume: f32,
  time: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<VolumeBin>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) intensity: f32,
  @location(1) uv: vec2<f32>,
}

fn heatmapColor(intensity: f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.0, 0.0, 0.5);
  let c1 = vec3<f32>(0.0, 0.5, 1.0);
  let c2 = vec3<f32>(0.0, 1.0, 0.5);
  let c3 = vec3<f32>(1.0, 1.0, 0.0);
  let c4 = vec3<f32>(1.0, 0.0, 0.0);

  let t = intensity * 4.0;
  let i = u32(t);
  let f = t - f32(i);

  if (i == 0u) return mix(c0, c1, f);
  if (i == 1u) return mix(c1, c2, f);
  if (i == 2u) return mix(c2, c3, f);
  return mix(c3, c4, f);
}

@vertex
fn vs_main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  let bin = bins[instIdx];
  let intensity = bin.volume / uniforms.maxVolume;

  let x = f32(bin.barIndex);
  let y = bin.price * 0.5;
  let corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.4, -0.5), vec2<f32>(0.4, -0.5),
    vec2<f32>(-0.4, 0.5), vec2<f32>(0.4, 0.5),
  );
  let uvCorners = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0),
  );

  var out: VertexOutput;
  out.position = uniforms.viewProjection * vec4<f32>(x + corners[vertIdx].x, y + corners[vertIdx].y, 0.0, 1.0);
  out.intensity = intensity;
  out.uv = uvCorners[vertIdx];
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(heatmapColor(in.intensity), 0.8);
}
