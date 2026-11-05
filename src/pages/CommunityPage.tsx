// Global community chat — one site-wide room for every signed-in
// Locora member.
//
// Access: the route is guarded by RequireSignedIn in App.tsx
// (guests redirect to /landing), and the server enforces the
// session on every community call (401 without one). Any signed-in
// user can see and post — no event registration needed. The chat
// itself is the shared CommunityChat component in global mode
// (eventId "global", channel `community:global`, id-only pings).
import React from 'react';
import { CommunityChat } from '../components/events/CommunityChat';

export function CommunityPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-4">
      <div>
        <h1 className="font-editorial text-3xl font-bold text-[#1E2320]">Community</h1>
        <p className="text-sm text-[#5F635D] mt-1">
          Chat with everyone on Locora — say hello, ask questions, share plans.
        </p>
      </div>
      <CommunityChat mode="global" eventId="global" eventTitle="Community" />
    </div>
  );
}
