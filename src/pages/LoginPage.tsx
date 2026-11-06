import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { authService } from '../services/auth-service';
import { isAdminEmail } from '../services/roles-service';
import { useToast } from '../components/ui/Toast';
import { GoogleAuthButton } from '../components/auth/GoogleAuthButton';

// Only same-site paths are accepted as a post-login destination —
// never an external URL, and never back to an auth page.
function safeReturnTo(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw === '/login' || raw.startsWith('/login?') || raw === '/signup' || raw === '/logout') return null;
  return raw;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // H1: set when the server refuses sign-in because the local account
  // has not verified its email yet (code "email_not_verified").
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resendMessage, setResendMessage] = useState('');
  const [resending, setResending] = useState(false);

  const returnTo = safeReturnTo(searchParams.get('returnTo'));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Please provide your email and password.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const user = await authService.login(email.trim(), password);
      toast({
        type: 'success',
        title: `Signed in as ${user.name}`,
        description: `Welcome back to Locora (${user.role} role).`,
      });
      if (returnTo) {
        navigate(returnTo);
      } else if (user.role === 'admin') {
        navigate('/admin');
      } else if (user.role === 'organizer') {
        navigate('/organizer/dashboard');
      } else {
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      // H1: unverified local account — show the verify message plus a
      // resend action instead of a bare "invalid credentials".
      const code = (err as any)?.details?.code;
      if ((err as any)?.status === 403 && code === 'email_not_verified') {
        setUnverifiedEmail(email.trim());
        setError(err instanceof Error ? err.message : 'Please verify your email before signing in.');
      } else {
        setUnverifiedEmail('');
        setError(err instanceof Error ? err.message : 'Invalid credentials');
      }
    } finally {
      setLoading(false);
    }
  };

  async function handleResend() {
    if (!unverifiedEmail || resending) return;
    setResending(true);
    setResendMessage('');
    try {
      await authService.resendVerification(unverifiedEmail);
      setResendMessage('If an account exists for that email, a new verification link has been sent. It expires in 24 hours — check your inbox and spam.');
    } catch {
      setResendMessage('Could not resend the link right now. Try again in a few minutes.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-12 sm:py-16 space-y-6">
      {/* Brand & Heading */}
      <div className="text-center space-y-2">
        <Link to="/" className="font-editorial text-3xl font-black tracking-tight text-[#1E2320] inline-block hover:text-[#1E3F35] transition-colors">
          Locora
        </Link>
        <h1 className="font-editorial text-2xl font-bold text-[#1E2320]">Sign in to your account</h1>
        <p className="text-xs text-[#5F635D]">
          Access your event tickets and saved gatherings.
        </p>
      </div>

      {/* Login Form */}
      <form
        onSubmit={handleSubmit}
        className="bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs space-y-4"
      >
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700">
            {error}
          </div>
        )}

        {/* H1: unverified local account — resend the verification link. */}
        {unverifiedEmail && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
            <p className="text-xs text-amber-800">
              Your email <span className="font-semibold">{unverifiedEmail}</span> is not verified yet.
              The link expires in 24 hours — check your inbox and spam.
            </p>
            {resendMessage && <p className="text-xs text-[#1E3F35]">{resendMessage}</p>}
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="w-full py-2 bg-white border border-amber-300 text-amber-900 text-xs font-semibold rounded-lg transition-colors disabled:opacity-60 cursor-pointer"
            >
              {resending ? 'Sending…' : 'Resend verification email'}
            </button>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
            Email Address
          </label>
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
          {isAdminEmail(email) && (
            <p className="mt-1.5 text-[11px] text-[#5F635D]">
              Admin accounts sign in with Google, not with a password — use the Google button below.
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-[#1E2320]">Password</label>
            <Link
              to="/forgot-password"
              className="text-[11px] text-[#1E3F35] hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8C887E]" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              className="w-full pl-9 pr-10 py-2.5 text-xs bg-white border border-[#E2DFD8] rounded-lg text-[#1E2320] focus:border-[#1E3F35]"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8C887E] hover:text-[#1E2320] p-0.5"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors shadow-xs cursor-pointer"
        >
          {loading ? 'Authenticating...' : 'Sign In with Email'}
        </button>

        <div className="relative my-4 flex items-center justify-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[#E5E1D8]" />
          </div>
          <span className="relative bg-white px-2 text-[11px] uppercase tracking-wider text-[#8C887E]">
            or continue with
          </span>
        </div>

        <GoogleAuthButton
          buttonText="Sign In with Google"
          returnTo={returnTo ?? undefined}
          disabled={loading}
          onSuccess={(user) => {
            toast({
              type: 'success',
              title: `Signed in as ${user.name}`,
              description: 'Welcome back to Locora!',
            });
            if (user.role === 'admin') {
              navigate('/admin');
            } else if (user.role === 'organizer') {
              navigate('/organizer/dashboard');
            } else {
              navigate('/dashboard');
            }
          }}
          onError={(msg) => {
            setError(msg);
          }}
        />
      </form>

      <p className="text-center text-xs text-[#5F635D]">
        Don't have an account?{' '}
        <Link to="/signup" className="text-[#1E3F35] font-semibold hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
