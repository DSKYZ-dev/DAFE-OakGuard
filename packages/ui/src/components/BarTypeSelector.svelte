<script lang="ts">
  import { getStore } from '../stores/chartStore';
  import type { BarTypeId } from '@dafe/types';

  const store = getStore();

  const barTypes: { id: BarTypeId; label: string }[] = [
    { id: 'candlestick', label: 'Candle' },
    { id: 'heikin-ashi', label: 'Heikin-Ashi' },
    { id: 'renko', label: 'Renko' },
    { id: 'range-bar', label: 'Range' },
    { id: 'tick-bar', label: 'Tick' },
    { id: 'volume-bar', label: 'Volume' },
    { id: 'line', label: 'Line' },
    { id: 'area', label: 'Area' },
    { id: 'footprint', label: 'Footprint' },
    { id: 'kagi', label: 'Kagi' },
  ];

  let open = false;

  function select(type: BarTypeId) {
    store.setBarType(type);
    open = false;
  }
</script>

<div class="selector">
  <button class="select-btn" on:click={() => open = !open}>
    {barTypes.find(t => t.id === store.barType)?.label || 'Candle'}
    <span class="arrow">▾</span>
  </button>
  {#if open}
    <div class="dropdown" on:mouseleave={() => open = false}>
      {#each barTypes as type}
        <button
          class="option {store.barType === type.id ? 'active' : ''}"
          on:click={() => select(type.id)}
        >
          {type.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .selector { position: relative; }
  .select-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid rgba(180, 140, 255, 0.2);
    border-radius: 4px;
    background: transparent;
    color: rgba(255,255,255,0.7);
    cursor: pointer;
    font-size: 12px;
  }
  .select-btn:hover { background: rgba(180, 140, 255, 0.1); }
  .arrow { font-size: 8px; }
  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    background: rgba(12, 12, 24, 0.95);
    border: 1px solid rgba(180, 140, 255, 0.15);
    border-radius: 6px;
    padding: 4px;
    min-width: 120px;
    z-index: 300;
  }
  .option {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: rgba(255,255,255,0.6);
    cursor: pointer;
    font-size: 12px;
    text-align: left;
  }
  .option:hover { background: rgba(180, 140, 255, 0.15); color: #b48cff; }
  .option.active { color: #b48cff; font-weight: 600; }
</style>
