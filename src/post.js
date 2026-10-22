// The high level's frame passes, loaded only on that level (a separate chunk: phones never download it).
//   scene -> 4x MSAA, half-float -> ambient occlusion (N8AO) -> [bloom, at dusk and night] -> tone mapping -> screen
import * as THREE from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

const MODES = { agx: ToneMappingMode.AGX, neutral: ToneMappingMode.NEUTRAL, aces: ToneMappingMode.ACES_FILMIC };

export function postPipeline(renderer, scene, camera, tone) {
  const composer = new EffectComposer(renderer, { multisampling: 4, frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));
  const ao = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
  Object.assign(ao.configuration, {
    aoRadius: 2.2, // metres: under balconies, at the foot of walls, where planters meet paving
    distanceFalloff: 0.6,
    intensity: 2.2,
    aoSamples: 16,
    denoiseSamples: 8,
    denoiseRadius: 10,
    halfRes: true,
    depthAwareUpsampling: true,
    gammaCorrection: false,
    color: new THREE.Color(0x0b0d10),
  });
  composer.addPass(ao);
  // the glow round the lamps, the lit windows and the signs at night (off by day: no cost)
  const bloom = new BloomEffect({ intensity: 0, luminanceThreshold: 0.85, luminanceSmoothing: 0.3, mipmapBlur: true, radius: 0.72, levels: 7 });
  const bloomPass = new EffectPass(camera, bloom);
  bloomPass.enabled = false;
  composer.addPass(bloomPass);
  composer.addPass(new EffectPass(camera, new ToneMappingEffect({ mode: MODES[tone] })));
  composer.setSize(innerWidth, innerHeight);
  return {
    render: (dt) => composer.render(dt),
    setSize: (w, h) => {
      renderer.setSize(w, h);
      composer.setSize(w, h);
    },
    // inside a flat: smaller radius, rooms are a few metres across
    walk: (on) => {
      ao.configuration.aoRadius = on ? 0.6 : 2.2;
      ao.configuration.distanceFalloff = on ? 0.35 : 0.6;
      ao.configuration.intensity = on ? 2.4 : 2.2;
    },
    ao,
    bloom: (k) => {
      bloom.intensity = k;
      bloomPass.enabled = k > 0.01;
    },
  };
}
