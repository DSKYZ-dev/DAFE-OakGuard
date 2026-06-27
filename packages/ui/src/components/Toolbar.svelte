<script lang="ts">
  import { getStore } from '../stores/chartStore';
  import ModeToggle3D from './ModeToggle3D.svelte';
  import BarTypeSelector from './BarTypeSelector.svelte';

  const store = getStore();
</script>

<div class="toolbar">
  <div class="toolbar-left">
    <span class="symbol">{store.symbol}</span>
    <span class="timeframe">{store.timeframe}</span>
  </div>
  <div class="toolbar-center">
    <BarTypeSelector />
    <ModeToggle3D />
  </div>
  <div class="toolbar-right">
    <span class="fps">{store.fps} FPS</span>
    <span class="bars">{store.barCount} bars</span>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: rgba(12, 12, 24, 0.9);
    border-bottom: 1px solid rgba(180, 140, 255, 0.1);
    user-select: none;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 200;
  }
  .toolbar-left, .toolbar-center, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .symbol {
    font-weight: 600;
    color: #b48cff;
    font-size: 14px;
  }
  .timeframe {
    color: rgba(255,255,255,0.4);
    font-size: 12px;
    padding: 2px 8px;
    background: rgba(180, 140, 255, 0.1);
    border-radius: 4px;
  }
  .fps, .bars {
    color: rgba(255,255,255,0.3);
    font-size: 11px;
    font-family: monospace;
  }
</style>
