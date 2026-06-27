import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';

export class PostProcessing {
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private ssaoPass: SSAOPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(renderer.domElement.width, renderer.domElement.height),
      0.3, 0.5, 0.1,
    );
    this.composer.addPass(this.bloomPass);

    this.ssaoPass = new SSAOPass(scene, camera);
    this.ssaoPass.enabled = false;
    this.composer.addPass(this.ssaoPass);

    this.composer.addPass(new OutputPass());
  }

  setBloom(strength: number): void {
    this.bloomPass.strength = strength;
  }

  setSSAO(enabled: boolean): void {
    this.ssaoPass.enabled = enabled;
  }

  render(): void {
    this.composer.render();
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  destroy(): void {
    this.composer.dispose();
  }
}
