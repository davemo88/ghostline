// Scene + RTS camera rig (§12): pan (WASD/arrows/edge-scroll/minimap), wheel
// zoom, fixed yaw, space snaps to the Commander, double-space toggles follow-cam.

import * as THREE from 'three';
import { MAP_SIZE } from '../sim';

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(MAP_SIZE / 2, 0, MAP_SIZE / 2); // look-at on ground
  dist = 90;
  follow = false;

  private keys = new Set<string>();
  private mouseAtEdge = { x: 0, y: 0 };

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101318);
    this.scene.fog = new THREE.Fog(0x101318, 160, 420);

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 800);

    const ambient = new THREE.AmbientLight(0x8090a8, 0.9);
    const sun = new THREE.DirectionalLight(0xdfe8ff, 1.4);
    sun.position.set(80, 140, 40);
    this.scene.add(ambient, sun);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
    window.addEventListener('keydown', (e) => this.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    window.addEventListener('mousemove', (e) => {
      const m = 12;
      this.mouseAtEdge.x = e.clientX < m ? -1 : e.clientX > window.innerWidth - m ? 1 : 0;
      this.mouseAtEdge.y = e.clientY < m ? -1 : e.clientY > window.innerHeight - m ? 1 : 0;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.dist = THREE.MathUtils.clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.1), 28, 170);
      },
      { passive: true },
    );
  }

  /** World position the camera centers on; call each frame. */
  update(dt: number, followPos: { x: number; z: number } | null): void {
    if (this.follow && followPos) {
      this.target.x = followPos.x;
      this.target.z = followPos.z;
    } else {
      const speed = this.dist * 0.9 * dt;
      let dx = this.mouseAtEdge.x;
      let dz = this.mouseAtEdge.y;
      if (this.keys.has('ArrowLeft') || this.keys.has('a')) dx -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('d')) dx += 1;
      if (this.keys.has('ArrowUp') || this.keys.has('w')) dz -= 1;
      if (this.keys.has('ArrowDown') || this.keys.has('s')) dz += 1;
      this.target.x = THREE.MathUtils.clamp(this.target.x + dx * speed, 0, MAP_SIZE);
      this.target.z = THREE.MathUtils.clamp(this.target.z + dz * speed, 0, MAP_SIZE);
      if (dx !== 0 || dz !== 0) this.follow = false;
    }
    this.camera.position.set(this.target.x, this.dist * 0.95, this.target.z + this.dist * 0.62);
    this.camera.lookAt(this.target.x, 0, this.target.z);
  }

  snapTo(x: number, z: number): void {
    this.target.x = x;
    this.target.z = z;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
