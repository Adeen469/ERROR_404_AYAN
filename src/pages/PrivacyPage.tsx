import React from 'react';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-editorial text-lg font-bold text-[#1E2320]">
        {title}
      </h2>
      <div className="text-sm text-[#5F635D] leading-relaxed space-y-3">
        {children}
      </div>
    </section>
  );
}

export function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div className="pb-4 border-b border-[#E5E1D8]">
        <h1 className="font-editorial text-3xl font-bold tracking-tight text-[#1E2320]">
          Privacy Policy
        </h1>
        <p className="text-sm text-[#5F635D] mt-1">
          Last updated: 25 October 2026. This policy explains what Locora
          collects, why it collects it, and what control you have over it.
        </p>
      </div>

      <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs space-y-8">
        <Section title="What Locora is">
          <p>
            Locora is a hyperlocal event discovery and community engagement
            platform. People discover nearby events, register for them, save
            events they like, and organizers publish events for their
            neighborhood. Locora is free to use and does not run ads.
          </p>
        </Section>

        <Section title="Information we collect">
          <p>
            <strong className="text-[#1E2320]">Account information.</strong>{' '}
            When you sign in with Google, we receive your name, email address,
            and profile picture from Google, and we store them so we can show
            you as signed in and attribute your events and registrations to
            you. If you create an account with an email and password instead,
            we store the name and email you provide.
          </p>
          <p>
            <strong className="text-[#1E2320]">Events and activity.</strong>{' '}
            Events you publish, events you register for, events you save, and
            preferences such as your home neighborhood and interests are
            stored so the service can work: listings, tickets, recommendations,
            and your dashboard all depend on them. Events you publish are
            visible to other Locora users by design.
          </p>
          <p>
            <strong className="text-[#1E2320]">
              Browser storage and cookies.
            </strong>{' '}
            Parts of your session, registrations, and saved events are kept in
            your browser&apos;s local storage. During Google sign-in and
            Google Calendar connection, we set a short-lived cookie that holds
            a one-time security token to prevent forged sign-in requests. It
            is not used for tracking or advertising.
          </p>
        </Section>

        <Section title="Google Calendar connection">
          <p>
            Connecting Google Calendar is optional. If you connect it, Locora
            requests a single Google permission: the ability to view and edit
            events on your calendars. In practice Locora only uses it in two
            ways:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              When you register for an event, Locora creates that event on
              your primary Google Calendar, with the event&apos;s title, date
              and time, venue, and description.
            </li>
            <li>
              When you cancel that registration, Locora deletes the calendar
              event it created.
            </li>
          </ul>
          <p>
            Locora never lists, reads, or copies your other calendar events.
            It never invites other people to your calendar events, and it
            never shares your calendar data with anyone.
          </p>
          <p>
            To make this work after you leave the site, Google issues Locora
            a refresh token. That token is stored encrypted (AES-GCM, with a
            key derived from a server-only secret) in Locora&apos;s database,
            and it is never shown to the browser or stored in your browser.
            Short-lived access tokens are created from it only when an event
            needs to be added or removed, and they are never stored.
            Disconnecting Google Calendar in your Profile deletes the stored
            token immediately. You can also revoke Locora&apos;s access at
            any time from your Google Account permissions page; if access has
            been revoked, Locora deletes the stored token the next time it
            tries to use it.
          </p>
        </Section>

        <Section title="Google sign-in">
          <p>
            Sign-in uses Google OAuth. Locora does not see or store your
            Google password. We only receive the basic profile information
            described above, and we use it to create and recognize your
            Locora account.
          </p>
        </Section>

        <Section title="How your information is stored and shared">
          <p>
            Locora&apos;s shared event data is stored in a hosted database,
            and the site itself is hosted on a cloud hosting platform. These
            providers store and process data only to run the service. Beyond
            that, Locora does not sell your personal information, does not
            share it with advertisers, and does not share your calendar data
            with any third party. Information is disclosed only if required by
            law.
          </p>
        </Section>

        <Section title="Your control">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong className="text-[#1E2320]">
                Disconnect Google Calendar
              </strong>{' '}
              at any time from your Profile page; this deletes the stored
              calendar token and stops all future calendar additions.
            </li>
            <li>
              <strong className="text-[#1E2320]">Cancel a registration</strong>{' '}
              from the event page; this also removes the calendar event
              Locora created for it.
            </li>
            <li>
              <strong className="text-[#1E2320]">Sign out</strong> from your
              Profile page at any time.
            </li>
            <li>
              <strong className="text-[#1E2320]">Revoke Google access</strong>{' '}
              from your Google Account permissions page; this cuts off
              Locora&apos;s calendar access entirely.
            </li>
          </ul>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If this policy changes in a way that affects how your data is
            used, the &quot;Last updated&quot; date above will change, and
            the updated policy will be posted on this page. Continued use of
            Locora after a change means you accept the updated policy.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about this policy can be sent to the developer contact
            email listed on Locora&apos;s Google OAuth consent screen.
          </p>
        </Section>
      </div>
    </div>
  );
}
