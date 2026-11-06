// Global community chat — one site-wide room for every signed-in
// Locora member.
//
// Access: the route is guarded by RequireSignedIn in App.tsx
// (guests redirect to /landing), and the server enforces the
// session on every community call (401 without one). Any signed-in
// user can see and post — no event registration needed. The chat
// itself is the shared CommunityChat component in global mode
// (eventId "global", channel `community:global`, ping-only by
// design — no bounded member list to fan out to).
//
// Layout: WhatsApp-style like MessagesPage — the chat fills the
// viewport (fullHeight), first screen shows navbar + chat only.
// There is no page header here; the chat's own header carries the
// room name. The footer sits flush under the chat (FooterSlot in
// App.tsx renders <Footer flush /> on /community).
import React from 'react';
import { CommunityChat } from '../components/events/CommunityChat';

export function CommunityPage() {
  return (
    <div>
      <CommunityChat mode="global" eventId="global" eventTitle="Community" fullHeight />
    </div>
  );
}
