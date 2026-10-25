import { Link } from 'react-router-dom';
import { ArrowLeft, KeyRound, Chrome } from 'lucide-react';

// This page used to fake a password reset: it waited 400ms and showed
// "Reset Link Sent" without sending anything, because there was no
// reset flow behind it. There still is no password to reset:
// - Locora accounts created with an email address have no password
//   here at all — sign-in checks only the email address, and the
//   password field on the sign-in form is not verified.
// - Accounts created with Google are secured by Google, so only
//   Google can reset those passwords.
// So this page tells the user exactly that, with a working path for
// each case, instead of promising an email that never arrives.
export function ForgotPasswordPage() {
  return (
    <div className="max-w-md mx-auto px-4 py-16 space-y-6">
      <Link
        to="/login"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#5F635D] hover:text-[#1E2320] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Sign In</span>
      </Link>

      <div className="text-center space-y-2">
        <h1 className="font-editorial text-2xl font-bold text-[#1E2320]">Trouble signing in?</h1>
        <p className="text-xs text-[#5F635D]">
          Locora doesn't send password reset emails — pick how you signed up.
        </p>
      </div>

      <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 bg-[#EAF1ED] text-[#1E3F35] rounded-xl flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h2 className="font-editorial text-base font-bold text-[#1E2320]">
              I signed up with an email address
            </h2>
            <p className="text-xs text-[#5F635D] leading-relaxed">
              Your Locora account has no password here — sign in with just
              your email address. That&apos;s all Locora checks.
            </p>
          </div>
        </div>
        <Link
          to="/login"
          className="inline-block px-5 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors"
        >
          Go to Sign In
        </Link>
      </div>

      <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 bg-[#EAF1ED] text-[#1E3F35] rounded-xl flex items-center justify-center shrink-0">
            <Chrome className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h2 className="font-editorial text-base font-bold text-[#1E2320]">
              I signed in with Google
            </h2>
            <p className="text-xs text-[#5F635D] leading-relaxed">
              Your password is managed by Google, not Locora. Reset it
              through Google&apos;s account recovery.
            </p>
          </div>
        </div>
        <a
          href="https://accounts.google.com/signin/recovery"
          target="_blank"
          rel="noreferrer"
          className="inline-block px-5 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors"
        >
          Reset via Google
        </a>
      </div>

      <p className="text-center text-[11px] text-[#5F635D]">
        Still stuck? Make sure you&apos;re using the same email address you signed up with.
      </p>
    </div>
  );
}
