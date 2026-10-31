- [x] Step 1: Add preview/test indicator execution support in apps/web/src/indicator-manager.ts (isolated preview plots)
- [x] Step 2: Extend bridge config + implement onTestScript in apps/web/src/main.ts (run preview only, don’t touch accepted instances)
- [x] Step 3: Modify "▶ Test Run" button to call onTestScript in apps/web/src/trade-advisor/oakscript-bridge.ts
- [x] Step 4: Update DEFAULT_SCRIPT placeholder to exact //DAFE Trading Systems - DskyzInvestment in apps/web/src/oakscript/editor.ts
- [x] Step 5: Verify placeholder/hasRealEditorScript logic in apps/web/src/main.ts matches new DEFAULT_SCRIPT
- [x] Step 6: Build/test via npm scripts (if present) and visually verify Accept vs Test behavior

## Notes

- **Isolated preview.** `indicator-manager.ts` runs a proposal without creating or editing an instance, sending alerts, emitting live signals (so the paper auto-trader cannot act on it), or touching the circuit breaker. The chart shows a "PREVIEW · not applied" badge.
- **Preview vs. accept.** Ask-mode proposals and "▶ Test Run" only preview. "✓ Accept & Apply" is the only path that writes to the editor and the accepted indicator. "✕ Decline" discards the preview and changes nothing.
- **Verified in the running app.** Preview leaves the editor and the dashboard unchanged, Test Run keeps that state, Decline discards, and Accept applies. This was checked through the DOM; screenshots were not available in the browser tool.
- **Verified by scripts.** `npm run lint`, `npm run build` (web and mobile), `npm test` (2,171,421 pass / 0 fail), `npm run verify:oakguard`, and `npm run verify:pipeline` all pass.
- **Also fixed.** The editor's "Auto-accept" checkbox dispatched an action that nothing handled, so it did nothing. It now sets the permission mode.
