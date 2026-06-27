use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn sum_f64_simd(values: &[f64]) -> f64 {
    values.iter().sum()
}

#[wasm_bindgen]
pub fn min_f64_simd(values: &[f64]) -> f64 {
    values.iter().copied().fold(f64::INFINITY, f64::min)
}

#[wasm_bindgen]
pub fn max_f64_simd(values: &[f64]) -> f64 {
    values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
}

#[wasm_bindgen]
pub fn normalize_f64(values: &[f64]) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }

    let min = min_f64_simd(values);
    let max = max_f64_simd(values);
    let range = max - min;

    if range == 0.0 {
        return vec![0.5; values.len()];
    }

    values.iter().map(|v| (v - min) / range).collect()
}

#[wasm_bindgen]
pub fn dot_product(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}
