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
  extrusionScale: f32,
  maxVolume: f32,
  time: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<VolumeBin>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) volumeRatio: f32,
  @location(2) depth: f32,
}

fn getBoxVertex(idx: u32, depth: f32) -> vec3<f32> {
  let x = f32(i32(idx) / 4 % 2);
  let y = f32(i32(idx) / 2 % 2);
  let z = f32(idx % 2);
  return vec3<f32>(x - 0.5, y - 0.5, z * depth);
}

fn getBoxNormal(idx: u32) -> vec3<f32> {
  let face = idx / 4;
  let normals = array<vec3<f32>, 6>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(-1.0, 0.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, -1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(0.0, 0.0, -1.0),
  );
  return normals[face];
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertIdx: u32,
  @builtin(instance_index) instIdx: u32,
) -> VertexOutput {
  let bin = bins[instIdx];
  let normalizedVol = bin.volume / uniforms.maxVolume;
  let depth = normalizedVol * uniforms.extrusionScale;

  let localPos = getBoxVertex(vertIdx, depth);
  let worldPos = vec3<f32>(
    f32(bin.barIndex),
    bin.price * 0.5,
    -localPos.z,
  );

  var out: VertexOutput;
  out.position = uniforms.viewProjection * vec4<f32>(worldPos, 1.0);
  out.normal = getBoxNormal(vertIdx);
  out.volumeRatio = bin.buyVolume / max(bin.volume, 0.001);
  out.depth = normalizedVol;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let bullColor = vec3<f32>(0.0, 1.0, 0.4);
  let bearColor = vec3<f32>(1.0, 0.2, 0.3);
  let baseColor = mix(bearColor, bullColor, in.volumeRatio);

  let glow = smoothstep(0.7, 1.0, in.depth) * 0.5;
  let lightDir = normalize(vec3<f32>(0.3, 0.5, 1.0));
  let diffuse = max(dot(in.normal, lightDir), 0.2);
  let finalColor = baseColor * diffuse + vec3<f32>(glow);

  return vec4<f32>(finalColor, 0.85);
}
