'use client';
// app/components/ParticleBackground.tsx — ported from ArxivExplorer

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export function ParticleBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef   = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return;
    mountedRef.current = true;
    const container = containerRef.current;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    scene.fog    = new THREE.Fog(0x000000, 800, 1600);
    const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 1, 10000);
    camera.position.set(866, 500, 0);
    camera.lookAt(0, 0, 0);

    const light = new THREE.HemisphereLight(0x77ffaa, 0x77ffaa, 1);
    light.position.set(866, 500, 0);
    scene.add(light);

    const moversNum = 20000;
    const movers: Array<{
      position: THREE.Vector3; velocity: THREE.Vector3;
      acceleration: THREE.Vector3; mass: number; isActive: boolean;
    }> = [];

    const geo1 = new THREE.BufferGeometry();
    const geo2 = new THREE.BufferGeometry();
    const pos1 = new Float32Array(moversNum * 3);
    const pos2 = new Float32Array(moversNum * 3);

    for (let i = 0; i < moversNum; i++) {
      const range = (1 - Math.log(Math.floor(Math.random() * 254) + 2) / Math.log(256)) * 500 + 100;
      const rad = (Math.random() * 360 * Math.PI) / 180;
      const x = Math.cos(rad) * range;
      const z = Math.sin(rad) * range;
      const mover = {
        position: new THREE.Vector3(x, 1000, z),
        velocity: new THREE.Vector3(x, 1000, z),
        acceleration: new THREE.Vector3(),
        mass: (Math.floor(Math.random() * 200) + 300) / 100,
        isActive: false,
      };
      movers.push(mover);
      const idx = i * 3;
      if (i % 2 === 0) { pos1[idx] = x; pos1[idx+1] = 1000; pos1[idx+2] = z; }
      else             { pos2[idx] = x; pos2[idx+1] = 1000; pos2[idx+2] = z; }
    }

    geo1.setAttribute('position', new THREE.BufferAttribute(pos1, 3));
    geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));

    const mat1 = new THREE.PointsMaterial({ color: 0x77ffaa, size: 4, transparent: true, opacity: 0.7, depthTest: false, blending: THREE.AdditiveBlending });
    const mat2 = new THREE.PointsMaterial({ color: 0x77aaff, size: 4, transparent: true, opacity: 0.7, depthTest: false, blending: THREE.AdditiveBlending });
    const pts1 = new THREE.Points(geo1, mat1);
    const pts2 = new THREE.Points(geo2, mat2);
    scene.add(pts1, pts2);

    const antigrav = new THREE.Vector3(0, 1.5, 0);
    let lastActivate = 0, cameraRad = (30 * Math.PI) / 180, lastTime = performance.now();

    const activateMovers = () => {
      let count = 0;
      for (const m of movers) {
        if (m.isActive) continue;
        m.isActive = true; m.velocity.y = -300;
        if (++count >= 40) break;
      }
    };

    const animate = (now: number) => {
      requestAnimationFrame(animate);
      const delta = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      if (now - lastActivate > 50) { activateMovers(); lastActivate = now; }

      const a1 = geo1.attributes.position as THREE.BufferAttribute;
      const a2 = geo2.attributes.position as THREE.BufferAttribute;
      const p1 = a1.array as Float32Array;
      const p2 = a2.array as Float32Array;

      for (let i = 0; i < movers.length; i++) {
        const m = movers[i]!;
        if (m.isActive) {
          const f = antigrav.clone().multiplyScalar(delta * 60);
          m.acceleration.add(f);
          m.acceleration.divideScalar(m.mass);
          m.velocity.add(m.acceleration.clone().multiplyScalar(delta * 60));
          m.position.add(m.velocity.clone().multiplyScalar(delta * 60));
          m.acceleration.set(0, 0, 0);
          if (m.position.y > 500) {
            const r2 = (1 - Math.log(Math.floor(Math.random() * 254) + 2) / Math.log(256)) * 500 + 100;
            const rad = (Math.random() * 360 * Math.PI) / 180;
            const nx = Math.cos(rad) * r2, nz = Math.sin(rad) * r2;
            m.position.set(nx, -300, nz); m.velocity.copy(m.position);
            m.mass = (Math.floor(Math.random() * 200) + 300) / 100;
          }
        }
        const idx = i * 3;
        if (i % 2 === 0) { p1[idx] = m.position.x; p1[idx+1] = m.position.y; p1[idx+2] = m.position.z; }
        else             { p2[idx] = m.position.x; p2[idx+1] = m.position.y; p2[idx+2] = m.position.z; }
      }
      a1.needsUpdate = true; a2.needsUpdate = true;

      cameraRad += ((0.03 * Math.PI) / 180) * delta * 60;
      camera.position.x = Math.cos(Math.PI / 3) * Math.cos(cameraRad) * 1000;
      camera.position.z = Math.cos(Math.PI / 3) * Math.sin(cameraRad) * 1000;
      camera.position.y = Math.sin(Math.PI / 3) * 1000;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    };
    animate(performance.now());

    const onResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('resize', onResize);
      if (container && renderer.domElement.parentNode === container)
        container.removeChild(renderer.domElement);
      geo1.dispose(); geo2.dispose(); mat1.dispose(); mat2.dispose(); renderer.dispose();
      scene.remove(pts1, pts2, light); scene.clear();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 pointer-events-none opacity-50 z-0"
      style={{ mixBlendMode: 'screen' }}
      aria-hidden="true"
    />
  );
}
