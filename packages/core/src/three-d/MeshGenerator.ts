import * as THREE from 'three';
import type { BaseBar } from '@dafe/types';

export class MeshGenerator {
  private sharedGeometry: THREE.BoxGeometry;

  constructor() {
    this.sharedGeometry = new THREE.BoxGeometry(0.8, 1, 1);
  }

  generateBarMeshes(bars: BaseBar[]): THREE.InstancedMesh[] {
    if (bars.length === 0) return [];

    const material = new THREE.MeshStandardMaterial({
      metalness: 0.3,
      roughness: 0.6,
      color: 0x44bb88,
    });

    const mesh = new THREE.InstancedMesh(this.sharedGeometry, material, bars.length);
    const dummy = new THREE.Object3D();
    const prices = bars.map(b => (b.high + b.low) / 2);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 1;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const height = Math.max(bar.high - bar.low, 0.01);
      const normalizedPrice = (prices[i] - minPrice) / priceRange;

      dummy.position.set(i - bars.length / 2, normalizedPrice * 20 - 5, 0);
      dummy.scale.set(1, height * 2, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const isBull = bar.close >= bar.open;
      mesh.setColorAt(i, new THREE.Color(isBull ? 0x22cc88 : 0xcc3344));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    return [mesh];
  }

  generateVolumeExtrusion(
    bins: { price: number; volume: number; buyVolume: number; sellVolume: number; barIndex: number }[],
    maxVolume: number,
    extrusionScale: number,
  ): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(0.6, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      metalness: 0.2,
      roughness: 0.5,
      transparent: true,
      opacity: 0.85,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, bins.length);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      const volRatio = bin.volume / maxVolume;
      const depth = volRatio * extrusionScale;

      dummy.position.set(bin.barIndex, bin.price * 2, -depth / 2);
      dummy.scale.set(0.8, 1, depth);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const ratio = bin.buyVolume / Math.max(bin.volume, 0.001);
      mesh.setColorAt(i, new THREE.Color(ratio, 1 - ratio, 0.3));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    return mesh;
  }
}
