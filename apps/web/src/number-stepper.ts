// Custom stepper for <input type="number">.
//
// Chromium paints a light-grey native spinner in number fields regardless of the
// page palette, which reads as an unstyled white widget inside the dark HUD
// panels. ui-chrome.css hides that spinner and draws themed chevrons on the
// field's right edge instead; this wires the click target so the chevrons
// actually step the value. Delegated from the document, so fields created later
// (Model Inputs rows, backtest form, settings) work without extra setup.

const CHEVRON_STRIP_PX = 13;

export function mountNumberSteppers(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'number' || target.disabled || target.readOnly) return;

    const rect = target.getBoundingClientRect();
    if (ev.clientX < rect.right - CHEVRON_STRIP_PX) return;

    const stepUp = ev.clientY < rect.top + rect.height / 2;
    target.focus();
    try {
      if (stepUp) target.stepUp();
      else target.stepDown();
    } catch {
      return; // no valid step for this field
    }
    // Match what the native spinner did for listeners already on the page.
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
