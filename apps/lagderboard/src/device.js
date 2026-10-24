// What a run was played on, for the leaderboard and the share card. The GPU name comes from Glitchless's device
// read (gd.device(), from the game's own WebGL context). Safari and Firefox hide the GPU model, so an iPhone is
// named by its screen size instead, which tells the models apart about as well as a browser allows.

const GENERIC_GPU = /^(apple gpu|unknown|none|webkit webgl|mozilla|adreno \(tm\)|mali|powervr)$/i;

export async function describeDevice(gd) {
  const d = gd.device();
  const ua = navigator.userAgent;
  const touchMac = d.os === 'macOS' && navigator.maxTouchPoints > 1; // iPadOS Safari says it's a Mac
  const iPad = /iPad/.test(ua) || touchMac;
  const iPhone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  const deviceClass = iPad || (android && !/Mobile/.test(ua)) ? 'tablet' : iPhone || d.mobile ? 'phone' : 'desktop';

  let model = '';
  try {
    if (navigator.userAgentData?.getHighEntropyValues) model = (await navigator.userAgentData.getHighEntropyValues(['model'])).model || '';
  } catch {
    // not offered; fine
  }

  const gpu = d.gpu && !GENERIC_GPU.test(d.gpu.trim()) && d.gpu_tier !== 'software' ? d.gpu.trim() : null;
  const [sw, sh] = d.screen ? [Math.min(...d.screen), Math.max(...d.screen)] : [0, 0];
  const size = sw ? `${sw}×${sh}` : '';

  let name;
  let short;
  if (iPhone) {
    name = `iPhone ${size}`.trim();
    short = 'iPhone';
  } else if (iPad) {
    name = `iPad ${size}`.trim();
    short = 'iPad';
  } else if (android) {
    name = model || gpu || `Android ${deviceClass}`;
    short = model || (deviceClass === 'tablet' ? 'tablet' : 'phone');
  } else {
    name = gpu || `${d.os} · ${d.browser}`;
    short = gpu || (d.os === 'macOS' ? 'Mac' : d.os === 'Other' ? 'computer' : `${d.os} PC`);
  }

  return {
    deviceClass,
    name: name.slice(0, 60),
    short: short.slice(0, 40),
    gpu,
    gpuTier: d.gpu_tier,
    browser: d.browser,
    os: d.os,
    label: [classLabel(deviceClass), name, d.browser].filter(Boolean).join(' · '),
  };
}

export function classLabel(c) {
  return { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' }[c] || 'Device';
}
