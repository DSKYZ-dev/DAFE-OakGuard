/**
 * Extreme-limit live prompts. Each one pushes a documented limit of the
 * generation pipeline: state-vs-event signals, non-price 3D layers, layer
 * caps, 3D-only shapes and labels, inline transition logic, Fibonacci levels,
 * five-channel arrays, and shockwave/label requests.
 *
 * Shared by tools/verify/extreme-limit-test.ts (--live) and the acceptance
 * harness (tools/verify/final-limit-run.ts --set extreme|all).
 */
export const EXTREME_LIMIT_PROMPTS: string[] = [
  'Create a volatility and momentum breakout model with buy and sell signals.',
  'Create a Fibonacci retracement indicator from the highest high and lowest low of the last 80 bars. Show the 23.6%, 38.2%, 50%, and 61.8% levels as separate clean 3D level lines, signal when price reclaims the 61.8% level or loses the 38.2% level, and label only the most important recent event instead of labeling every signal.',
  'Create a 3D Spot-Vol Term Structure & Skew Reliquary model across three horizons (fast 10-bar, medium 30-bar, and slow 60-bar realized volatility of returns, plus directional skew from price position in the rolling range). Render the term structure as a 3D manifold surface with a front ribbon spine and an impulse bars3d layer in the separate pane, plot the 2D term-structure spread and skew in the lower pane, and fire sparse buy/sell signals on the main chart only when fast volatility expands out of compression while skew flips bullish or bearish.',
  'Create a 3D cellular signal array indicator that reads an array of 5 distinct channel strengths [ch1, ch2, ch3, ch4, ch5] mapped to 5 parallel vertical cylinders. The height of each cylinder must correspond linearly to its channel value (0 to 100 dBm). Additionally, draw a dynamic 3D spline curve connecting the top faces of all 5 cylinders, changing the curve\'s thickness based on the average value of the entire array.',
  'Compile a 3D wind velocity vector indicator. The asset must feature an aerodynamic arrow mesh anchored at the origin (0,0,0). The arrow\'s 3D orientation (Pitch, Yaw, Roll) must perfectly map to an incoming 3D vector variable wind_direction_vector (x, y, z). The length of the arrow tail must stretch, and its base color must shift along a blue-to-orange gradient, depending on a scalar wind_speed_knots variable.',
  'Design a 3D pressure valve indicator that displays a flat circular disc spinning on the Y-axis at a speed proportional to flow_psi. When flow_psi exceeds a critical threshold of 150, the disc must lock in place, and a series of expanding 3D concentric shockwave rings must procedurally radiate outward from the perimeter. Simultaneously, a floating 3D text mesh reading \'OVERPRESSURE\' must instantiate above it.',
];
