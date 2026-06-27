pub mod bars;
pub mod volume;
pub mod indicators;
pub mod simd;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}
