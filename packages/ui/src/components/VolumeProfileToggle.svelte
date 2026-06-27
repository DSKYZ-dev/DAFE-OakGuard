<script lang="ts">
  import { getStore } from '../stores/chartStore';
  import type { VolumeProfileMode } from '@dafe/types';

  const store = getStore();

  const modes: { id: VolumeProfileMode; icon: string; label: string }[] = [
    { id: '2D-Side', icon: '⊞', label: '2D Side Profile' },
    { id: '2D-Per-Bar', icon: '⊟', label: '2D Per-Bar' },
    { id: '3D-Extrude', icon: '⊠', label: '3D Extruded' },
    { id: '3D-Heatmap', icon: '⚏', label: '3D Heatmap' },
  ];

  function handleToggle() {
    store.toggleVolumeProfile();
  }

  function handleModeClick(modeId: VolumeProfileMode) {
    store.setVolumeProfile({ mode: modeId, enabled: true });
  }
</script>

<div class="volume-toggle">
  <div class="rail">
    <button
      class="toggle-btn {store.volumeProfile.enabled ? 'active' : ''}"
      on:click={handleToggle}
      title="Toggle Volume Profile"
    >
      <span class="icon">⊘</span>
      <span class="label">Off</span>
    </button>

    {#each modes as mode}
      <button
        class="mode-btn {store.volumeProfile.mode === mode.id && store.volumeProfile.enabled ? 'active' : ''}"
        on:click={() => handleModeClick(mode.id)}
        title={mode.label}
      >
        <span class="icon">{mode.icon}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .volume-toggle {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 100;
  }
  .rail {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: rgba(12, 12, 24, 0.85);
    border: 1px solid rgba(180, 140, 255, 0.2);
    border-radius: 8px;
    padding: 6px;
  }
  .toggle-btn, .mode-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    transition: all 0.15s ease;
    font-size: 16px;
  }
  .toggle-btn:hover, .mode-btn:hover {
    background: rgba(180, 140, 255, 0.15);
    color: rgba(255,255,255,0.8);
  }
  .toggle-btn.active, .mode-btn.active {
    background: rgba(180, 140, 255, 0.25);
    color: #b48cff;
    box-shadow: 0 0 8px rgba(180, 140, 255, 0.3);
  }
  .label {
    display: none;
    font-size: 9px;
    margin-top: 2px;
  }
</style>
