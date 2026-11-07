// A place on a heatmap (SPEC §3b Positions): one level, one zone (setZone), or the whole game, for a game whose
// players move about with no level set, such as a hub or a lobby. A positions panel names one (`level`, `zone` or
// neither), and so does the Heatmaps view's query (`level=`, `zone=` or `all=1`). Position samples and deaths are in
// a place when they carry its level or its zone (every one is in the whole game).
//
// Background pictures (`map` events from an SDK's captureMap, and the ones uploaded with PUT /v1/maps, maps.js) belong
// to places too: a map with a `level` is that level's (the web SDK also stamps the zone it was captured in, which
// doesn't count), one with only a `zone` that zone's, and one with neither the whole game's. A place draws its own
// map; a zone without one draws the whole game's, since a zone is an area of the same world (a hub's hall), so its
// positions land where they are on the whole picture. A level never borrows: levels have worlds of their own.

import crypto from 'node:crypto';

// { level }, { zone } or {} (the whole game), from a panel, a map or a query's fields: a level outranks a zone.
export function placeOf({ level, zone } = {}) {
  if (level != null && level !== '') return { level: String(level) };
  if (zone != null && zone !== '') return { zone: String(zone) };
  return {};
}

// The place a heatmap query asks for (level=, zone=, all=1), or null when it names none (heatmapPlace picks one).
export function placeFromParams(params) {
  if (params.get('level')) return { level: params.get('level') };
  if (params.get('zone')) return { zone: params.get('zone') };
  if (params.get('all') === '1' || params.get('all') === 'true') return {};
  return null;
}

// Whether an event (a pos batch, a death) happened in the place.
export function inPlace(place, e) {
  if (place.level != null) return e.level === place.level;
  if (place.zone != null) return e.zone === place.zone;
  return true;
}

// A string naming the place, for keys (the drill-downs' position samples, a store's map items).
export function placeKey(place) {
  return place.level != null ? `level:${place.level}` : place.zone != null ? `zone:${place.zone}` : 'all';
}

export function samePlace(a, b) {
  return placeKey(a) === placeKey(b);
}

// How a line of text names the place: "on cave", "in hall", or nothing for the whole game.
export function placeWords(place, { level = 'on', zone = 'in' } = {}) {
  return place.level != null ? ` ${level} ${place.level}` : place.zone != null ? ` ${zone} ${place.zone}` : '';
}

// The place's own fields, for an answer: { level }, { zone } or {}.
export function placeFields(place) {
  return place.level != null ? { level: place.level } : place.zone != null ? { zone: place.zone } : {};
}

// ───────────────────────────── maps ─────────────────────────────

// A map's sort key in a store: "<level>#<version>" as level maps always had, "~zone~<zone>#<version>" for a zone's
// and "~all~#<version>" for the whole game's. An uploaded background takes "~upload" for its version, so an upload
// and an SDK's capture of one place never replace each other.
export function mapSortKey(m) {
  const p = placeOf(m);
  const slot = p.level != null ? p.level : p.zone != null ? `~zone~${p.zone}` : '~all~';
  return `${slot}#${m.uploaded ? '~upload' : m.version}`;
}

// The map a place is drawn on: an uploaded background first (someone chose it), else the capture from this
// version, else the newest capture; for a zone without a map of its own, the whole game's the same way.
export function pickMap(maps, place, version) {
  const mine = (maps || []).filter((m) => samePlace(placeOf(m), place));
  if (!mine.length) return place.zone != null ? pickMap(maps, {}, version) : null;
  const newest = (list) => list.sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  const uploaded = mine.filter((m) => m.uploaded);
  if (uploaded.length) return newest(uploaded);
  return mine.find((m) => m.version === version) || newest(mine);
}

// A map's picture's own address: the first 16 hex characters of the SHA-256 of its image, so a new picture gets
// a new address and the browser keeps each one for good.
export function mapId(m) {
  return crypto.createHash('sha256').update(String(m.image || '')).digest('hex').slice(0, 16);
}

// What a positions panel says of its background: where to fetch the picture (GET /v1/maps/image, a share link's
// reader too) and its size, never the picture itself, so a game polling the panel downloads nothing more.
export function mapRef(service, m) {
  if (!m?.image) return null;
  const id = mapId(m);
  return { url: `/v1/maps/image?service=${encodeURIComponent(service)}&id=${id}`, id, size: m.size ?? null, uploaded: !!m.uploaded };
}
