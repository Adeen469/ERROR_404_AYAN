import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { authService } from '../services/auth-service';

// H1 verify-result page (audit #4, link-based email verification).
// The emailed link hits the API directly —
//   /api/auth/verify-email?token=<raw>
// — which verifies and 302-redirects here with ?status=verified,
// ?status=expired, ?status=invalid, ?status=too-many or ?status=error.
// This page never signs the user in from the link: after a successful
// verification the user signs in normally. If the page is opened with
// ?token= directly, it calls the API itself instead. Expired/invalid
// links offer a resend form (generic response — same message whether
// the email exists or not).
type Status = 'verifying' | 'verified' | 'expired' | 'invalid' | 'too-many' | 'error';

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const statusParam = searchParams.get('status') || '';
  const tokenParam = searchParams.get('token') || '';
  const [status, setStatus] = useState<Status>(tokenParam ? 'verifying' : (['verified', 'expired', 'invalid', 'too-many', 'error'].includes(statusParam) ? (statusParam as Status) : 'invalid'));
  const [email, setEmail] = useState('');
  const [resendMessage, setResendMessage] = useState('');
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (!tokenParam) return;
    let cancelled = false;
    (async () => {
      try {
        await authService.verifyEmail(tokenParam);
        if (!cancelled) setStatus('verified');
      } catch (err: any) {
        if (cancelled) return;
        const msg = String(err?.message || '');
        setStatus(msg.toLowerCase().includes('expired') ? 'expired' : 'invalid');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenParam]);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || resending) return;
    setResending(true);
    setResendMessage('');
    try {
      await authService.resendVerification(email.trim());
      setResendMessage('If an account exists for that email, a new verification link has been sent. It expires in 24 hours — check your inbox and spam.');
    } catch {
      setResendMessage('Could not resend the link right now. Try again in a few minutes.');
    } finally {
      setResending(false);
    }
  }

  const copy: Record<Status, { title: string; body: string }> = {
    verifying: { title: 'Verifying your email…', body: 'Please wait while we confirm your email address.' },
    verified: { title: 'Email verified', body: 'Your email is confirmed. You can now sign in to Locora.' },
    expired: { title: 'This link has expired', body: 'Verification links expire after 24 hours and can only be used once. Request a new one below.' },
    invalid: { title: 'This link is not valid', body: 'The verification link is invalid or has already been used. Request a new one below.' },
    'too-many': { title: 'Too many attempts', body: 'Too many verification attempts. Wait a little while, then request a new link below.' },
    error: { title: 'Verification failed', body: 'Something went wrong while verifying your email. Try the link again, or request a new one below.' },
  };
  const { title, body } = copy[status];

  return (
    <div className="max-w-md mx-auto px-4 py-16 space-y-6">
      <div className="text-center space-y-2">
        <h1 className="font-editorial text-2xl font-bold text-[#1E2320]">{title}</h1>
        <p className="text-xs text-[#5F635D] leading-relaxed">{body}</p>
      </div>
      <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs space-y-4">
        {status === 'verified' ? (
          <Link
            to="/login"
            className="block w-full text-center py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors"
          >
            Sign in
          </Link>
        ) : status !== 'verifying' ? (
          <form onSubmit={handleResend} className="space-y-3">
            {resendMessage && (
              <div className="p-3 bg-[#EAF1ED] border border-[#D0E2D9] rounded-xl text-xs text-[#1E3F35]">{resendMessage}</div>
            )}
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8C887E]" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full pl-9 pr-3 py-2.5 text-xs bg-white border border-[#E2DFD8] rounded-lg text-[#1E2320] focus:border-[#1E3F35]"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={resending}
              className="w-full py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-60 cursor-pointer"
            >
              {resending ? 'Sending…' : 'Send a new verification link'}
            </button>
          </form>
        ) : (
          <p className="text-center text-xs text-[#5F635D]">Verifying…</p>
        )}
        <p className="text-center text-xs text-[#5F635D]">
          <Link to="/login" className="text-[#1E3F35] font-semibold hover:underline">Back to Sign In</Link>
          {' · '}
          <Link to="/signup" className="text-[#1E3F35] font-semibold hover:underline">Sign Up</Link>
        </p>
      </div>
    </div>
  );
}
