<script lang="ts">
  import { getStore } from '../stores/chartStore';

  const store = getStore();

  function toggle3D() {
    store.setMode(store.mode === '2D' ? '3D' : '2D');
  }
</script>

<button
  class="mode-toggle {store.mode === '3D' ? 'active' : ''}"
  on:click={toggle3D}
  title="Toggle 2D/3D Mode"
>
  <span class="icon">{store.mode === '3D' ? '⬡' : '▭'}</span>
  <span class="label">{store.mode}</span>
</button>

<style>
  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid rgba(180, 140, 255, 0.2);
    border-radius: 6px;
    background: rgba(12, 12, 24, 0.85);
    color: rgba(255,255,255,0.6);
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .mode-toggle:hover {
    background: rgba(180, 140, 255, 0.15);
  }
  .mode-toggle.active {
    border-color: #b48cff;
    color: #b48cff;
    box-shadow: 0 0 8px rgba(180, 140, 255, 0.2);
  }
  .icon { font-size: 18px; }
</style>
