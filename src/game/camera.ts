/** Third-person orbit camera with building occlusion. */
import * as THREE from 'three';
import type { AABB } from './props';
import { pointInside } from './physics';

export class CameraRig {
  yaw = 0;             // forward() = -Z at start, i.e. looking up the avenue to the roundabout
  pitch = 0.32;
  dist = 6.5;
  minDist = 2.5; maxDist = 12;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private curDist = 6.5;
  /** When set, the camera glides to a front-facing portrait view (Style Studio). */
  portrait = false;

  constructor(public camera: THREE.PerspectiveCamera) {}

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.0042;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.0032, -0.15, 1.2);
  }
  zoom(delta: number) { this.dist = THREE.MathUtils.clamp(this.dist + delta * 0.8, this.minDist, this.maxDist); }

  /** Forward direction on the ground plane (unit vector). */
  forward() { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right() { return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  update(dt: number, target: THREE.Vector3, targetYaw: number, colliders: AABB[], indoor: boolean) {
    const focus = target.clone().add(new THREE.Vector3(0, 1.45, 0));
    let yaw = this.yaw, pitch = this.pitch, dist = this.dist;
    if (!this.portrait && innerHeight > innerWidth) { focus.y += 0.65; dist = Math.min(dist + 1.2, this.maxDist); } // phone: frame like a mobile game
    if (this.portrait) {
      // in front of the player, slightly above eye line
      // camera sits where the avatar is looking, so we see the face
      yaw = targetYaw; pitch = 0.02; dist = 3.6;
      focus.y = 1.0;
      const side = innerWidth > 720 ? 0.45 : 0; // desktop: leave room for the panel on the right
      focus.add(new THREE.Vector3(Math.cos(targetYaw) * side, 0, -Math.sin(targetYaw) * side));
    } else if (indoor) {
      dist = Math.min(dist, 5.2);
    }
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    // occlusion: march from the player outwards and stop in front of the first wall
    let d = dist;
    const steps = 28;
    const probe = new THREE.Vector3();
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * dist;
      probe.copy(focus).addScaledVector(dir, t);
      if (pointInside(probe.x, probe.y, probe.z, colliders)) { d = ((i - 1) / steps) * dist - 0.25; break; }
    }
    d = Math.max(1.0, d);
    this.curDist = THREE.MathUtils.lerp(this.curDist, d, Math.min(1, dt * (d < this.curDist ? 18 : 4)));
    const desired = focus.clone().addScaledVector(dir, this.curDist);
    if (desired.y < 0.5) desired.y = 0.5;
    const k = this.portrait ? Math.min(1, dt * 6) : 1;
    this.pos.lerp(desired, k);
    this.look.lerp(focus, k);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  snapTo(target: THREE.Vector3) {
    const focus = target.clone().add(new THREE.Vector3(0, 1.45, 0));
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.pos.copy(focus).addScaledVector(dir, this.dist);
    this.look.copy(focus);
    this.curDist = this.dist;
  }
}
