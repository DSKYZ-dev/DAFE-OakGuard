use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compute_sma(values: &[f64], period: u32) -> Vec<f64> {
    let period = period as usize;
    let mut result = vec![0.0_f64; values.len()];

    for i in period..values.len() {
        let mut sum = 0.0;
        for j in 0..period {
            sum += values[i - j];
        }
        result[i] = sum / period as f64;
    }

    result
}

#[wasm_bindgen]
pub fn compute_ema(values: &[f64], period: u32) -> Vec<f64> {
    let period = period as usize;
    let alpha = 2.0 / (period + 1) as f64;
    let mut result = vec![0.0_f64; values.len()];

    if values.is_empty() {
        return result;
    }

    result[0] = values[0];
    for i in 1..values.len() {
        result[i] = alpha * values[i] + (1.0 - alpha) * result[i - 1];
    }

    result
}

#[wasm_bindgen]
pub fn compute_rsi(values: &[f64], period: u32) -> Vec<f64> {
    let period = period as usize;
    let mut result = vec![0.0_f64; values.len()];

    for i in period..values.len() {
        let mut gains = 0.0;
        let mut losses = 0.0;
        for j in (i - period + 1)..=i {
            let diff = values[j] - values[j - 1];
            if diff > 0.0 {
                gains += diff;
            } else {
                losses -= diff;
            }
        }
        let avg_gain = gains / period as f64;
        let avg_loss = losses / period as f64;
        result[i] = if avg_loss == 0.0 {
            100.0
        } else {
            100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
        };
    }

    result
}
