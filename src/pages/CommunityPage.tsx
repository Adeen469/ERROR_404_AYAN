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
import React from 'react';
import { Users } from 'lucide-react';
import { CommunityChat } from '../components/events/CommunityChat';

export function CommunityPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-[#1E3F35] text-white flex items-center justify-center shrink-0">
          <Users className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h1 className="font-editorial text-3xl font-bold text-[#1E2320] leading-tight">Community</h1>
          <p className="text-sm text-[#5F635D] mt-1">
            Chat with everyone on Locora — say hello, ask questions, share plans.
          </p>
        </div>
      </div>
      <CommunityChat mode="global" eventId="global" eventTitle="Community" />
    </div>
  );
}
