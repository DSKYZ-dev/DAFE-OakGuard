import * as THREE from 'three';

export class LightingRig {
  private ambient: THREE.AmbientLight;
  private directional: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private rim: THREE.DirectionalLight;

  constructor(scene: THREE.Scene) {
    this.ambient = new THREE.AmbientLight(0x404060, 0.4);
    scene.add(this.ambient);

    this.directional = new THREE.DirectionalLight(0xffffff, 1.2);
    this.directional.position.set(60, 100, 40);
    this.directional.castShadow = true;
    this.directional.shadow.mapSize.width = 2048;
    this.directional.shadow.mapSize.height = 2048;
    scene.add(this.directional);

    this.fill = new THREE.DirectionalLight(0x8888ff, 0.4);
    this.fill.position.set(-40, 20, -30);
    scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xff8844, 0.3);
    this.rim.position.set(0, -10, -80);
    scene.add(this.rim);
  }

  setIntensity(multiplier: number): void {
    this.ambient.intensity = 0.4 * multiplier;
    this.directional.intensity = 1.2 * multiplier;
    this.fill.intensity = 0.4 * multiplier;
    this.rim.intensity = 0.3 * multiplier;
  }
}
