// The glass brain (port of the Neurals hero drop): a wobbling glass body with a neuron inside, tinted by rarity.
import * as THREE from 'three';
import { RoomEnvironment } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/environments/RoomEnvironment.js';

export function mountBrain(canvas, { tint = '#dfe3f2', inner = '#2a5dff', orbit = [], size = 1, drift = true } = {}) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(2, devicePixelRatio)); r.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene(); const pm = new THREE.PMREMGenerator(r);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100); cam.position.set(0, 0, 14);
  const uni = { uT: { value: 0 } };
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(tint), transmission: 0.92, thickness: 2.2, roughness: 0.1, ior: 1.33, clearcoat: 1, clearcoatRoughness: 0.08, iridescence: 0.45, envMapIntensity: 1.7, attenuationColor: new THREE.Color(tint), attenuationDistance: 2.4 });
  mat.onBeforeCompile = (s) => { s.uniforms.uT = uni.uT; s.vertexShader = 'uniform float uT;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    float w = sin(position.x * 1.7 + uT * 1.1) * 0.11 + sin(position.y * 2.3 + uT * 0.8) * 0.1 + sin(position.z * 1.9 + uT * 1.4) * 0.08; transformed += normal * w;`); };
  const group = new THREE.Group(); scene.add(group);
  group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.7 * size, 48), mat));
  // neuron inside: soma + dendrites
  const nm = new THREE.MeshStandardMaterial({ color: inner, roughness: 0.3, metalness: 0.15, emissive: inner, emissiveIntensity: 0.25 });
  const neuron = new THREE.Group(); group.add(neuron);
  neuron.add(new THREE.Mesh(new THREE.SphereGeometry(0.26 * size, 24, 16), nm));
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2, b = (k % 3 - 1) * 0.6;
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * 0.45, b * 0.4, Math.sin(a) * 0.45), new THREE.Vector3(Math.cos(a + 0.4) * 0.85, b * 0.75, Math.sin(a + 0.4) * 0.85)].map((v) => v.multiplyScalar(size));
    neuron.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.035 * size, 6), nm));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07 * size, 12, 8), nm); tip.position.copy(pts[2]); neuron.add(tip);
  }
  const sats = orbit.map((c, i) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.16 * size, 24, 16), new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.15, clearcoat: 1, emissive: c, emissiveIntensity: 0.35 })); scene.add(m); return { m, a: (i / orbit.length) * Math.PI * 2, r: 2.6 * size, s: 0.25 + i * 0.04 }; });
  scene.add(new THREE.AmbientLight(0xffffff, 0.6)); const dl = new THREE.DirectionalLight(0xffffff, 1.5); dl.position.set(3, 6, 5); scene.add(dl);
  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(canvas); resize();
  let mx = 0, my = 0; addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; });
  const t0 = performance.now();
  (function f() {
    const t = (performance.now() - t0) / 1000; uni.uT.value = t;
    group.rotation.y = t * 0.25 + mx * 0.6; group.rotation.x = my * 0.4;
    neuron.rotation.y = -t * 0.6; neuron.rotation.z = Math.sin(t * 0.7) * 0.3;
    if (drift) group.position.y = Math.sin(t * 0.9) * 0.15;
    for (const s of sats) { const a = s.a + t * s.s; s.m.position.set(Math.cos(a) * s.r, Math.sin(a * 1.3) * 0.7, Math.sin(a) * s.r * 0.6); }
    r.render(scene, cam); requestAnimationFrame(f);
  })();
  return r;
}
