// A jam room's join page on the open-source server, <base><CODE>/join (docs/design/jam-rooms.md §9): a maker's first ten
// minutes. The room's title and code, the commands that connect their coding agent to THIS server (glitchless-jam to
// join and publish, glitchless-mcp to read what players hit), and one prompt to paste. Glitchless Cloud passes its own
// join page to RoomRoute, with sign-in and making a game.
import { useEffect } from 'react';
import { CodeBlock } from '../components.jsx';
import { publicApiUrl } from '../api.js';
import { roomCall, roomLinks, usePoll, RoomStage, RoomGone, RoomLoading, JamState } from '../room.jsx';

const SETUP_PROMPT = 'https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/agent-setup-prompt.md';

export function RoomJoin({ code, base }) {
  const q = usePoll(() => roomCall('GET', code), 0, [code]);
  const r = q.data;
  useEffect(() => {
    if (r?.title) document.title = `Join ${r.title}`;
  }, [r?.title]);
  if (!r) return q.error ? <RoomGone code={code} error={q.error} /> : <RoomLoading />;

  const url = publicApiUrl();
  const links = roomLinks(r.code, base);
  const jam = `claude mcp add glitchless-jam -e GLITCHLESS_URL=${url} -- npx -y glitchless-jam`;
  const mcp = `claude mcp add glitchless -e GLITCHLESS_URL=${url} -- npx -y glitchless-mcp`;
  const config = JSON.stringify(
    {
      mcpServers: {
        'glitchless-jam': { command: 'npx', args: ['-y', 'glitchless-jam'], env: { GLITCHLESS_URL: url } },
        glitchless: { command: 'npx', args: ['-y', 'glitchless-mcp'], env: { GLITCHLESS_URL: url } },
      },
    },
    null,
    2,
  );
  const prompt = `We're in a game jam: jam room ${r.code} on the Glitchless server at ${url}.

1. Make a small game that runs in a browser (plain HTML and JavaScript, or Vite). Build it with relative paths so it works from any folder: with Vite, vite build --base ./
2. Add Glitchless to it by following ${SETUP_PROMPT} with the intake URL ${url} and the client token gl_pub_dev. Give Glitchless.init a service name for this game and a version.
${
    r.online
      ? `3. Zip the built folder, with index.html at the root of the zip, for me to upload to the game's itch.io page as an HTML5 game (kind of project: HTML, played in the browser). Once I have, ask me for the page's address, the game's title and the name to show as its maker, then link that version to room ${r.code} with the glitchless_jam tool (action "link").
4. Before you link a fix, bump the version you pass to Glitchless.init, build and zip it again, and link the new version once I've uploaded it.`
      : `3. Ask me for the game's title and the name to show as its maker, then publish the built folder to room ${r.code} with the glitchless_jam tool, and show me the link and the QR code it answers with.
4. Before you publish a fix, bump the version you pass to Glitchless.init.`
  }`;

  return (
    <div className="room room-join">
      <RoomStage kicker="Join the jam" title={r.title}>
        <div className="room-status">
          <JamState room={r} />
          <span className="room-code-line">
            Room <b className="room-code">{r.code}</b>
          </span>
        </div>
      </RoomStage>
      <main className="room-main narrow">
        {r.ended ? (
          <div className="room-empty">
            <h2>This jam has ended</h2>
            <p>
              Games can't join or publish any more. See the awards on <a href={links.arcade}>the arcade</a>.
            </p>
          </div>
        ) : !r.joining ? (
          <div className="room-empty">
            <h2>This room has stopped taking new games</h2>
            <p>Games already in it can still publish new versions. Ask the organiser if you think yours should be in.</p>
          </div>
        ) : (
          <ol className="room-steps">
            <li>
              <h2>Connect your coding agent to this server</h2>
              <p>In a terminal, in your game's folder. glitchless-jam joins the room and publishes your game; glitchless gives your agent your game's numbers: its plays, errors and stutter.</p>
              <CodeBlock code={`${jam}\n${mcp}`} />
              <details className="room-details">
                <summary>Another agent (Codex, Cursor, …)</summary>
                <p>Add both servers to its MCP settings:</p>
                <CodeBlock code={config} />
              </details>
              <p className="room-sub">If the organiser set a key on this server, add -e GLITCHLESS_API_KEY=… with the key they give you.</p>
            </li>
            <li>
              <h2>Paste this to your agent</h2>
              <CodeBlock code={prompt} />
            </li>
            <li>
              <h2>Play everyone's games</h2>
              <p>
                Your game shows up on <a href={links.arcade}>the arcade</a> the moment it's {r.online ? 'linked' : 'published'}, next to everyone else's. Scan the codes with your phone, play, and vote for your favourite.
              </p>
            </li>
          </ol>
        )}
      </main>
    </div>
  );
}
