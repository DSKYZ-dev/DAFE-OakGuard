use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
#[wasm_bindgen]
pub struct TickData {
    pub price: f64,
    pub size: f64,
    pub side: u8,
    pub timestamp: f64,
}

#[derive(Clone, Copy)]
#[wasm_bindgen]
pub struct BarData {
    pub timestamp: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[wasm_bindgen]
pub fn aggregate_candlesticks(ticks: &[TickData], period: u32) -> Vec<BarData> {
    let mut bars = Vec::new();
    if ticks.is_empty() {
        return bars;
    }

    let period = period as usize;
    let mut i = 0;
    while i < ticks.len() {
        let end = (i + period).min(ticks.len());
        let slice = &ticks[i..end];
        if slice.is_empty() {
            break;
        }

        let bar = BarData {
            timestamp: slice[0].timestamp,
            open: slice[0].price,
            high: slice.iter().map(|t| t.price).fold(f64::NEG_INFINITY, f64::max),
            low: slice.iter().map(|t| t.price).fold(f64::INFINITY, f64::min),
            close: slice[slice.len() - 1].price,
            volume: slice.iter().map(|t| t.size).sum(),
        };
        bars.push(bar);
        i += period;
    }

    bars
}

#[wasm_bindgen]
pub fn aggregate_heikin_ashi(ticks: &[TickData], period: u32) -> Vec<BarData> {
    let raw = aggregate_candlesticks(ticks, period);
    if raw.is_empty() {
        return raw;
    }

    let mut ha_bars = Vec::with_capacity(raw.len());
    let mut prev_ha_close = raw[0].open;

    for bar in &raw {
        let ha_close = (bar.open + bar.high + bar.low + bar.close) / 4.0;
        let ha_open = match ha_bars.last() {
            Some(last) => (prev_ha_close + last.open) / 2.0,
            None => prev_ha_close,
        };
        let ha_high = bar.high.max(ha_open).max(ha_close);
        let ha_low = bar.low.min(ha_open).min(ha_close);

        ha_bars.push(BarData {
            timestamp: bar.timestamp,
            open: ha_open,
            high: ha_high,
            low: ha_low,
            close: ha_close,
            volume: bar.volume,
        });
        prev_ha_close = ha_close;
    }

    ha_bars
}
