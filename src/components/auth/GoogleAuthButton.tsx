import React, { useState, useEffect, useRef } from 'react';
import { authService } from '../../services/auth-service';
import { UserProfile } from '../../types';
import { KeyRound, ExternalLink, Check, AlertCircle, Loader2 } from 'lucide-react';

interface GoogleAuthButtonProps {
  role?: 'attendee' | 'organizer';
  buttonText?: string;
  onSuccess: (user: UserProfile) => void;
  onError: (errorMsg: string) => void;
  disabled?: boolean;
}

export function GoogleAuthButton({
  role = 'attendee',
  buttonText = 'Continue with Google',
  onSuccess,
  onError,
  disabled = false,
}: GoogleAuthButtonProps) {
  const [loading, setLoading] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [customClientId, setCustomClientId] = useState('');
  const [currentOrigin, setCurrentOrigin] = useState('');
  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setCurrentOrigin(window.location.origin);
      const configuredId = authService.getGoogleClientId();
      setCustomClientId(configuredId);

      // Initialize Google Identity Services if client ID exists and window.google is loaded
      if (configuredId && window.google?.accounts?.id && googleBtnContainerRef.current) {
        try {
          window.google.accounts.id.initialize({
            client_id: configuredId,
            callback: async (response: any) => {
              if (response.credential) {
                setLoading(true);
                try {
                  const user = await authService.loginWithGoogleCredential(response.credential, role);
                  onSuccess(user);
                } catch (err: any) {
                  onError(err.message || 'Failed to authenticate with Google credential.');
                } finally {
                  setLoading(false);
                }
              }
            },
          });
        } catch (e) {
          console.warn('GSI init notice:', e);
        }
      }
    }
  }, [role, onSuccess, onError]);

  const handleClick = async () => {
    const clientId = authService.getGoogleClientId();
    if (!clientId) {
      setShowConfigModal(true);
      return;
    }

    setLoading(true);
    onError('');

    try {
      const user = await authService.loginWithGoogle(role);
      onSuccess(user);
    } catch (err: any) {
      if (err.message && err.message.includes('GOOGLE_CLIENT_ID_NOT_CONFIGURED')) {
        setShowConfigModal(true);
      } else {
        onError(err.message || 'Google authentication failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSaveCustomClientId = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customClientId.trim()) {
      authService.setCustomGoogleClientId('');
      setShowConfigModal(false);
      return;
    }
    authService.setCustomGoogleClientId(customClientId.trim());
    setShowConfigModal(false);
    // Trigger login immediately with newly entered Client ID
    setTimeout(() => {
      handleClick();
    }, 100);
  };

  return (
    <>
      <div className="space-y-2">
        <button
          type="button"
          disabled={disabled || loading}
          onClick={handleClick}
          className="w-full py-2.5 px-4 bg-white hover:bg-[#F4F1EA] text-[#1E2320] border border-[#E2DFD8] text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2.5 cursor-pointer shadow-2xs disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 text-[#1E3F35] animate-spin" />
              <span>Connecting to Google...</span>
            </>
          ) : (
            <>
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>{buttonText}</span>
            </>
          )}
        </button>

        {/* Hidden anchor for GSI standard rendering if needed */}
        <div ref={googleBtnContainerRef} className="hidden" aria-hidden="true" />
      </div>

      {/* Google OAuth Configuration Modal (Shown if GOOGLE_CLIENT_ID is not configured yet) */}
      {showConfigModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-[#E5E1D8] space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-[#EAF1ED] rounded-lg text-[#1E3F35]">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-editorial text-lg font-bold text-[#1E2320]">
                    Google OAuth Setup
                  </h3>
                  <p className="text-[11px] text-[#5F635D]">
                    Direct Google Authentication
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowConfigModal(false)}
                className="text-[#8C887E] hover:text-[#1E2320] text-sm font-semibold p-1"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-[#5F635D] space-y-2.5 bg-[#FAF8F5] p-3.5 rounded-xl border border-[#E5E1D8]">
              <div className="flex items-center gap-1.5 font-medium text-[#1E2320]">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>Google Client ID required for live OAuth</span>
              </div>
              <p>
                To enable live Google Sign-In, make sure your Google Cloud Console Web Client includes this authorized origin:
              </p>
              <div className="p-2 bg-white rounded border border-[#E2DFD8] font-mono text-[11px] text-[#1E3F35] select-all break-all">
                {currentOrigin || 'https://locora-hyperlocal.vercel.app'}
              </div>
              <p className="text-[11px] leading-relaxed">
                Add <code>GOOGLE_CLIENT_ID</code> in Vercel Environment Variables, or enter it below to test immediately in this session:
              </p>
            </div>

            <form onSubmit={handleSaveCustomClientId} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-[#1E2320] mb-1">
                  Google Client ID (ends with .apps.googleusercontent.com)
                </label>
                <input
                  type="text"
                  value={customClientId}
                  onChange={(e) => setCustomClientId(e.target.value)}
                  placeholder="123456789-abcdef.apps.googleusercontent.com"
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E2DFD8] rounded-lg text-[#1E2320] font-mono focus:border-[#1E3F35]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowConfigModal(false)}
                  className="px-3 py-2 text-xs text-[#5F635D] hover:text-[#1E2320] font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Save & Connect</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
