// The jam's own app (SPEC §3j): jam rooms live apart from the Glitchless dashboard, at an address of their own,
// jam.glitchless.gg on Glitchless Cloud and /jam/ on the open-source server and a laptop's cloud. jam.html loads it
// (jam.jsx); the server serves that page for every path under the jam's base.
//   <base>              the organiser's home: their rooms, each room's survey, survey templates and past jams (Rooms.jsx)
//   <base><CODE>[/…]    a room's pages, open to anyone: the arcade, the big screen, the survey, the join page (Room.jsx)
// A host's shell renders JamApp with its own
//   base            where the jam is, ending in / (default: /jam/ on a path under /jam, else /)
//   voterHeaders, signInUrl, joinPage
//                   for the room's pages (RoomRoute, Room.jsx)
//   organiserGate   a component ({ children }) around the organiser's home: Glitchless Cloud's signs in and checks the
//                   organiser allow-list. The default lets everyone through, and a 401 asks for the server's key (api.js)
//   dashboardUrl    a link back to the Glitchless dashboard on the organiser's home (default: the server's root under
//                   /jam/, none at the root of a host of the jam's own)
import { lazy, Suspense, useEffect } from 'react';
import { jamBase, roomPath, RoomStage } from '../room.jsx';
import { RoomRoute } from './Room.jsx';

// The organiser's page uses the dashboard's panels; phones opening a room don't load them.
const Rooms = lazy(() => import('./Rooms.jsx').then((m) => ({ default: m.Rooms })));

const PassThrough = ({ children }) => children;

export function JamApp({ base = jamBase(), voterHeaders, signInUrl, joinPage, organiserGate: Gate = PassThrough, dashboardUrl = base === '/jam/' ? '/' : null, path = window.location.pathname }) {
  const at = roomPath(path, base);
  if (at && !at.home) return <RoomRoute path={path} base={at.base} voterHeaders={voterHeaders} signInUrl={signInUrl} joinPage={joinPage} />;
  return (
    <Gate>
      <JamHome base={at?.base ?? base} dashboardUrl={dashboardUrl} />
    </Gate>
  );
}

// The organiser's home, framed as the jam's own pages are: the navy stage, then their rooms and survey templates.
function JamHome({ base, dashboardUrl }) {
  useEffect(() => {
    document.title = 'Glitchless Jam';
  }, []);
  return (
    <div className="room room-home">
      <RoomStage
        kicker="Organiser"
        title="Your jam rooms"
        className="compact"
        aside={
          dashboardUrl ? (
            <a className="room-home-dash" href={dashboardUrl}>
              Glitchless dashboard →
            </a>
          ) : null
        }
      >
        <p className="room-about">Make a room and put its code on the big screen. Makers' agents publish their games to it, everyone plays them on their phones, and when the jam ends the room hands out awards and asks how it went.</p>
      </RoomStage>
      <main className="room-main room-home-main">
        <Suspense fallback={<div className="loading-bar" />}>
          <Rooms base={base} />
        </Suspense>
      </main>
    </div>
  );
}
