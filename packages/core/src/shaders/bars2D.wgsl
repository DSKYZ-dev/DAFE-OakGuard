struct BarData {
  timestamp: f32,
  open: f32,
  high: f32,
  low: f32,
  close: f32,
  volume: f32,
}

struct Uniforms {
  projection: mat4x4<f32>,
  view: mat4x4<f32>,
  priceScale: f32,
  timeScale: f32,
  priceOffset: f32,
  timeOffset: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> bars: array<BarData>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  let bar = bars[instIdx];
  let x = (bar.timestamp - uniforms.timeOffset) * uniforms.timeScale;
  let bodyWidth = 4.0;
  let wickWidth = 1.0;
  let isBull = bar.close >= bar.open;

  var pos: vec2<f32>;
  if (vertIdx < 2u) {
    let y = select(bar.low, bar.high, vertIdx == 0u);
    let dx = select(-wickWidth, wickWidth, vertIdx == 1u);
    pos = vec2<f32>(x + dx, y);
  } else {
    let corner = vertIdx - 2u;
    let left = f32(corner & 1u) == 0.0;
    let top = corner < 2u;
    pos = vec2<f32>(
      x + select(bodyWidth, -bodyWidth, left),
      select(bar.close, bar.open, top),
    );
  }

  let worldPos = vec3<f32>(pos.x, pos.y, 0.0);
  var out: VertexOutput;
  out.position = uniforms.projection * uniforms.view * vec4<f32>(worldPos, 1.0);
  out.color = select(vec3<f32>(1.0, 0.2, 0.3), vec3<f32>(0.0, 1.0, 0.4), isBull);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
