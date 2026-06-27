<script lang="ts">
  import { getStore } from '../stores/chartStore';

  const store = getStore();
  let visible = false;

  function toggle() { visible = !visible; }
</script>

<button class="dashboard-toggle" on:click={toggle} title="Dashboard">
  📊
</button>

{#if visible}
  <div class="dashboard">
    <div class="panel">
      <h3>Performance</h3>
      <div class="stat">
        <span>FPS</span><span>{store.fps}</span>
      </div>
      <div class="stat">
        <span>Bars</span><span>{store.barCount}</span>
      </div>
    </div>
    <div class="panel">
      <h3>Volume Profile</h3>
      <div class="stat">
        <span>Mode</span><span>{store.volumeProfile.mode}</span>
      </div>
      <div class="stat">
        <span>POC</span><span>{store.volumeProfile.showPOC ? 'On' : 'Off'}</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .dashboard-toggle {
    position: absolute;
    bottom: 8px;
    right: 8px;
    z-index: 200;
    background: rgba(12, 12, 24, 0.85);
    border: 1px solid rgba(180, 140, 255, 0.2);
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 16px;
  }
  .dashboard {
    position: absolute;
    bottom: 44px;
    right: 8px;
    z-index: 200;
    background: rgba(12, 12, 24, 0.95);
    border: 1px solid rgba(180, 140, 255, 0.15);
    border-radius: 8px;
    padding: 12px;
    min-width: 160px;
  }
  .panel { margin-bottom: 8px; }
  .panel h3 {
    font-size: 11px;
    color: #b48cff;
    margin: 0 0 6px 0;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .stat {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: rgba(255,255,255,0.6);
    padding: 2px 0;
  }
</style>
