// Device + GPU fingerprinting. Game perf is dominated by the GPU, so "Chrome on macOS"
// is not a useful segment — "Intel UHD 620" vs "Apple M3 Pro" is.

// Anonymous mode: what's common to many players. No GPU model string, core count or memory size.
export function anonymizeDevice(device) {
  if (!device) return null;
  const major = device.browser_version ? String(device.browser_version).split('.')[0] : null;
  return { browser: device.browser, browser_version: major, os: device.os, mobile: device.mobile, gpu_tier: device.gpu_tier, webgl: device.webgl, screen: device.screen, dpr: device.dpr };
}

export function collectDevice(gl) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const { browser, browserVersion, os, mobile } = parseUserAgent(nav);
  const gpu = gl ? readGpu(gl) : probeGpu();
  return {
    browser,
    browser_version: browserVersion,
    os,
    mobile,
    gpu: gpu.renderer,
    gpu_vendor: gpu.vendor,
    gpu_tier: classifyGpu(gpu.renderer),
    webgl: gpu.webgl,
    cores: nav.hardwareConcurrency || null,
    memory_gb: nav.deviceMemory || null,
    screen: typeof screen !== 'undefined' ? [screen.width, screen.height] : null,
    dpr: typeof devicePixelRatio !== 'undefined' ? round2(devicePixelRatio) : 1,
  };
}

function parseUserAgent(nav) {
  const ua = nav.userAgent || '';
  const uad = nav.userAgentData;
  let browser = 'Other';
  let browserVersion = '';
  const m =
    ua.match(/(Edg|OPR|Firefox|CriOS|Chrome|Version)\/(\d+)/) ||
    ua.match(/(Safari)\/(\d+)/);
  if (m) {
    browser = { Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', Version: 'Safari' }[m[1]] || m[1];
    browserVersion = m[2];
  }
  let os = 'Other';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  const mobile = uad ? !!uad.mobile : /Mobi|Android|iPhone|iPad/.test(ua);
  return { browser, browserVersion, os, mobile };
}

function readGpu(gl) {
  let renderer = '';
  let vendor = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  } catch {
    // Some privacy modes throw here; tier falls back to "unknown".
  }
  const webgl =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
      ? 'webgl2'
      : 'webgl1';
  return { renderer: cleanGpu(renderer), vendor: cleanVendor(vendor, renderer), webgl };
}

function probeGpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { renderer: 'none', vendor: 'none', webgl: 'none' };
    const info = readGpu(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  } catch {
    return { renderer: 'unknown', vendor: 'unknown', webgl: 'unknown' };
  }
}

// "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)" → "Apple M3 Pro"
function cleanGpu(s) {
  if (!s) return 'unknown';
  const angle = s.match(/ANGLE \((.+)\)/);
  if (angle) {
    const parts = angle[1].split(',').map((p) => p.trim());
    let name = parts[1] || parts[0];
    name = name.replace(/^ANGLE Metal Renderer:\s*/, '');
    name = name.replace(/\s*Direct3D.*$/, '').replace(/\s*\(0x[0-9A-Fa-f]+\)/g, '');
    name = name.replace(/\s*vs_\d_\d.*$/, '').replace(/\s*OpenGL.*$/, '');
    return name.trim() || s;
  }
  return s.trim();
}

function cleanVendor(vendor, renderer) {
  const s = `${vendor} ${renderer}`.toLowerCase();
  if (s.includes('apple')) return 'Apple';
  if (s.includes('nvidia') || s.includes('geforce')) return 'NVIDIA';
  if (s.includes('amd') || s.includes('radeon')) return 'AMD';
  if (s.includes('intel')) return 'Intel';
  if (s.includes('qualcomm') || s.includes('adreno')) return 'Qualcomm';
  if (s.includes('arm') || s.includes('mali')) return 'ARM';
  if (s.includes('swiftshader') || s.includes('google')) return 'Google (software)';
  return vendor || 'unknown';
}

export function classifyGpu(name = '') {
  const s = name.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(s)) return 'software';
  if (/apple m\d+ (pro|max|ultra)|rtx|radeon rx|radeon pro|quadro|geforce gtx 1[06-9]|arc a7/.test(s))
    return 'high';
  if (/adreno|mali|powervr|apple a\d+|apple gpu$/.test(s)) return 'low';
  if (/intel.*(hd|uhd) graphics|intel\(r\) (hd|uhd)/.test(s)) return 'low';
  if (/apple m\d+|apple gpu|iris|arc|radeon|geforce|nvidia/.test(s)) return 'mid';
  return 'unknown';
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
