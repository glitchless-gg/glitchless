// Google's test phones. Google Play's pre-launch report plays every new Android build on Firebase Test Lab's phones,
// and those runs are bots, not players. The SDKs mark them on the device where they can (Godot and Unity: the
// firebase.test.lab setting, or a GPU that draws in software), but pre-launch phones don't always say so, and a build
// already in the store has the SDK it shipped with. So intake also checks where a batch came from: a session that
// starts from one of the addresses Google publishes for Test Lab is synthetic, whatever engine sent it.
//
// The caller's address is used for this check only, while the batch is read, and is never stored or sent on.
import net from 'node:net';
import { isCompanion } from './ingest.js';

// Firebase Test Lab's published device addresses (firebase.google.com/docs/test-lab/overview, read 26 October 2026:
// physical and Arm virtual devices, then non-Arm virtual devices). Google adds blocks every few months: check the page
// about once a year.
export const TEST_LAB_RANGES = [
  '70.32.128.0/19', '108.177.6.0/23', '108.177.18.192/26', '108.177.29.64/27', '108.177.31.160/27', '199.36.156.8/29',
  '199.36.156.16/28', '209.85.131.0/27', '70.32.128.48/28', '70.32.150.192/27', '108.177.6.0/27', '108.177.24.160/27',
  '108.177.29.0/27', '108.177.25.128/27', '108.177.26.128/26', '108.177.29.192/26', '172.217.120.64/26',
  '172.217.120.128/26',
  '2001:4860:1008::/48', '2001:4860:1018::/48', '2001:4860:1019::/48', '2001:4860:1020::/48', '2001:4860:1022::/48',
  '2001:4860:101d::/48', '2001:4860:101e::/48', '2001:4860:1031::/48', '2001:4860:1037::/48', '2001:4860:1038::/48',
  '2001:4860:103a::/48',
  '34.68.194.64/29', '34.69.234.64/29', '34.73.34.72/29', '34.73.178.72/29', '34.74.10.72/29', '34.136.2.136/29',
  '34.136.50.136/29', '34.145.234.144/29', '35.192.160.56/29', '35.196.166.80/29', '35.196.169.240/29', '35.203.128.0/28',
  '35.234.176.160/28', '35.243.2.0/27', '35.245.243.240/29', '199.192.115.0/30', '199.192.115.8/30', '199.192.115.16/29',
];

const blocks = new net.BlockList();
for (const range of TEST_LAB_RANGES) {
  const [ip, bits] = range.split('/');
  blocks.addSubnet(ip, Number(bits), net.isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

// An address (IPv4, IPv6, an IPv4-mapped IPv6 one, or with a :port or [brackets]) → whether it is a Test Lab device's.
export function isTestLabAddress(address) {
  let a = String(address || '').trim();
  if (!a) return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.replace(/:\d+$/, '');
  a = a.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').replace(/%.*$/, '');
  const kind = net.isIP(a);
  return kind !== 0 && blocks.check(a, kind === 6 ? 'ipv6' : 'ipv4');
}

// Normalised events of one batch, and where it came from → the same events, with a player's session_start from a Test
// Lab address made synthetic. A type the game chose (tester, synthetic, simulated) and a server's session stay as they are.
export function markTestLab(events, address) {
  if (!events.some((e) => e.type === 'session_start') || !isTestLabAddress(address)) return events;
  return events.map((e) => (e.type === 'session_start' && !isCompanion(e.service) && (e.session_type == null || e.session_type === 'user') ? { ...e, session_type: 'synthetic' } : e));
}
