use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
#[wasm_bindgen]
pub struct VolumeBin {
    pub price: f64,
    pub volume: f64,
    pub buy_volume: f64,
    pub sell_volume: f64,
    pub bar_index: u32,
    pub tick_count: u32,
}

#[wasm_bindgen]
pub fn bin_volume_fixed(
    prices: &[f64],
    volumes: &[f64],
    buy_volumes: &[f64],
    sell_volumes: &[f64],
    bar_index: u32,
    resolution: f64,
) -> Vec<VolumeBin> {
    use std::collections::HashMap;

    let mut bin_map: HashMap<i64, VolumeBin> = HashMap::new();

    for i in 0..prices.len() {
        let bin_price = (prices[i] / resolution).round() as i64;
        let bin = bin_map.entry(bin_price).or_insert(VolumeBin {
            price: bin_price as f64 * resolution,
            volume: 0.0,
            buy_volume: 0.0,
            sell_volume: 0.0,
            bar_index,
            tick_count: 0,
        });
        bin.volume += volumes[i];
        bin.buy_volume += buy_volumes[i];
        bin.sell_volume += sell_volumes[i];
        bin.tick_count += 1;
    }

    let mut bins: Vec<VolumeBin> = bin_map.into_values().collect();
    bins.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap());
    bins
}

#[wasm_bindgen]
pub fn calculate_poc(bins: &[VolumeBin]) -> usize {
    let mut max_vol = 0.0_f64;
    let mut poc_idx = 0;

    for (i, bin) in bins.iter().enumerate() {
        if bin.volume > max_vol {
            max_vol = bin.volume;
            poc_idx = i;
        }
    }

    poc_idx
}

#[wasm_bindgen]
pub fn calculate_value_area(
    bins: &[VolumeBin],
    poc_index: usize,
    target_percent: f64,
) -> Vec<f64> {
    let total_volume: f64 = bins.iter().map(|b| b.volume).sum();
    if total_volume == 0.0 {
        return vec![0.0, 0.0, 0.0];
    }

    let target_volume = total_volume * target_percent / 100.0;
    let mut included = bins[poc_index].volume;
    let mut lower = poc_index as i32 - 1;
    let mut upper = poc_index as i32 + 1;

    while included < target_volume {
        let lower_vol = if lower >= 0 { bins[lower as usize].volume } else { 0.0 };
        let upper_vol = if (upper as usize) < bins.len() { bins[upper as usize].volume } else { 0.0 };

        if lower_vol >= upper_vol && lower >= 0 {
            included += lower_vol;
            lower -= 1;
        } else if (upper as usize) < bins.len() {
            included += upper_vol;
            upper += 1;
        } else {
            break;
        }
    }

    vec![
        bins[upper.max(0).min(bins.len() as i32 - 1) as usize].price,
        bins[lower.max(0) as usize].price,
        (included / total_volume) * 100.0,
    ]
}
