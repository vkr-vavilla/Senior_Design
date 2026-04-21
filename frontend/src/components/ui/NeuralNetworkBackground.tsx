'use client';

import { useEffect, useRef } from 'react';

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pulsePhase: number;
  pulseSpeed: number;
}

interface Pulse {
  fromIndex: number;
  toIndex: number;
  progress: number;
  speed: number;
}

const NODE_COUNT = 38;
const CONNECTION_DIST = 160;
const MAX_PULSES = 18;

export function NeuralNetworkBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let nodes: Node[] = [];
    let pulses: Pulse[] = [];

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };

    const initNodes = () => {
      nodes = Array.from({ length: NODE_COUNT }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 2 + 1.5,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.02 + Math.random() * 0.015,
      }));
    };

    const spawnPulse = () => {
      if (pulses.length >= MAX_PULSES) return;
      // find a random connected pair
      const fromIndex = Math.floor(Math.random() * nodes.length);
      const from = nodes[fromIndex];
      const candidates: number[] = [];
      for (let i = 0; i < nodes.length; i++) {
        if (i === fromIndex) continue;
        const dx = nodes[i].x - from.x;
        const dy = nodes[i].y - from.y;
        if (Math.sqrt(dx * dx + dy * dy) < CONNECTION_DIST) candidates.push(i);
      }
      if (candidates.length === 0) return;
      const toIndex = candidates[Math.floor(Math.random() * candidates.length)];
      pulses.push({ fromIndex, toIndex, progress: 0, speed: 0.008 + Math.random() * 0.012 });
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update nodes
      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > canvas.width) node.vx *= -1;
        if (node.y < 0 || node.y > canvas.height) node.vy *= -1;
        node.pulsePhase += node.pulseSpeed;
      }

      // Draw connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECTION_DIST) {
            const alpha = (1 - dist / CONNECTION_DIST) * 0.18;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = `rgba(99,102,241,${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
      }

      // Draw pulses along connections
      pulses = pulses.filter((p) => p.progress <= 1);
      for (const pulse of pulses) {
        const from = nodes[pulse.fromIndex];
        const to = nodes[pulse.toIndex];
        const x = from.x + (to.x - from.x) * pulse.progress;
        const y = from.y + (to.y - from.y) * pulse.progress;

        const grd = ctx.createRadialGradient(x, y, 0, x, y, 6);
        grd.addColorStop(0, 'rgba(139,92,246,0.9)');
        grd.addColorStop(0.5, 'rgba(99,102,241,0.4)');
        grd.addColorStop(1, 'rgba(99,102,241,0)');
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        pulse.progress += pulse.speed;
      }

      // Draw nodes
      for (const node of nodes) {
        const glow = 0.6 + 0.4 * Math.sin(node.pulsePhase);
        const grd = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 3);
        grd.addColorStop(0, `rgba(139,92,246,${0.9 * glow})`);
        grd.addColorStop(0.5, `rgba(99,102,241,${0.4 * glow})`);
        grd.addColorStop(1, 'rgba(99,102,241,0)');
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 3, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(167,139,250,${0.85 * glow})`;
        ctx.fill();
      }

      // Occasionally spawn pulses
      if (Math.random() < 0.04) spawnPulse();

      animId = requestAnimationFrame(draw);
    };

    resize();
    initNodes();
    draw();

    const ro = new ResizeObserver(() => {
      resize();
      initNodes();
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  );
}
