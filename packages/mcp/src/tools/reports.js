// Bug reports players send from inside the game: what they wrote, where they were and, when asked, what they saw.
import { z } from 'zod';
import { query, resolveService, range, reply, common, tool } from '../context.js';

tool(
  'glitchless_bug_reports',
  "Bug reports players sent from inside the game (a hotkey such as F8, or a button in the game): what they wrote, the level, their position, device and version, and the session to look at with glitchless_session. Without an id: the window's reports, newest first, optionally on one level. With an id: one report with the game events just before it and the frame rate around it; add screenshot: true to see what the player saw. Several reports on one level also show up in glitchless_triage.",
  {
    service: common.service,
    hours: z.number().min(0.25).max(9600).optional().describe('Look-back window in hours (default 168, a week)'),
    version: common.version,
    level: z.string().optional().describe('Only reports sent on this level, e.g. "level-2"'),
    id: z.string().optional().describe('One report, by its id from the list or from a glitchless_triage finding'),
    screenshot: z.boolean().optional().describe("With id: include the player's screenshot, as an image"),
  },
  async ({ service, hours, version, level, id, screenshot }) => {
    const svc = await resolveService(service);
    if (id) {
      const { report, error } = await query('report', { service: svc, id, screenshot: screenshot ? 1 : 0 });
      if (!report) throw new Error(`${error || 'report not found'}: ${id} in ${svc}`);
      const { screenshot: image, ...rest } = report;
      const out = reply(`Bug report ${id} in ${svc}, sent ${when(report.ts)} on ${report.level ?? 'no level'}. To see what led up to it, call glitchless_session with session_id "${report.session_id}".`, {
        ...rest,
        ts: when(rest.ts),
        recent: rest.recent.map((e) => ({ ...e, ts: when(e.ts) })),
        frames: rest.frames.map((f) => ({ ...f, ts: when(f.ts) })),
      });
      const m = image && /^data:(image\/[a-z]+);base64,/.exec(image);
      if (m) out.content.push({ type: 'image', data: image.slice(m[0].length), mimeType: m[1] });
      else if (screenshot) out.content[0].text += `\n\n(${report.has_screenshot ? 'The screenshot could not be read.' : 'The player sent no screenshot.'})`;
      return out;
    }
    const { reports = [] } = await query('reports', { service: svc, version, ...range(hours || 168) });
    const list = level ? reports.filter((r) => r.level === level) : reports;
    const brief = list
      .slice(0, 20)
      .map((r) => `- ${when(r.ts)} ${r.level ?? '(no level)'}: ${r.note ? `"${r.note.length > 100 ? r.note.slice(0, 97) + '…' : r.note}"` : '(no note)'} (${r.id})`)
      .join('\n');
    return reply(
      `${list.length} bug report(s) for ${svc}${level ? ` on ${level}` : ''} in the last ${hours || 168}h${version ? `, ${version}` : ''}:\n${brief || 'None. Players send them from inside the game once it turns them on (bugReports in Glitchless.init, or the engine SDK\'s report call).'}\n\nOpen one with its id (and screenshot: true to see it).`,
      list.map((r) => ({ ...r, ts: when(r.ts) })),
    );
  },
);

function when(ts) {
  return typeof ts === 'number' ? new Date(ts).toISOString() : ts;
}
