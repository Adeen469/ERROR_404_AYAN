import { UserProfile } from '../types';
import { DEFAULT_DEMO_USER, DEFAULT_DEMO_ORGANIZER_USER } from '../mocks/demo-data';
import { isDemoMode, apiClient } from './api-client';

const USER_STORAGE_KEY = 'locora_current_user';
const TOKEN_STORAGE_KEY = 'locora_auth_token';
const CUSTOM_CLIENT_ID_KEY = 'locora_custom_google_client_id';

type AuthListener = (user: UserProfile | null) => void;
const listeners = new Set<AuthListener>();

function notify(user: UserProfile | null) {
  listeners.forEach((cb) => cb(user));
}

/**
 * Native, zero-dependency JWT decoder for Google Identity tokens
 */
function parseJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (err) {
    console.warn('Failed to parse Google JWT credential payload:', err);
    return null;
  }
}

/**
 * Loads the official Google Identity Services SDK script dynamically if not yet ready
 */
function ensureGoogleIdentityScriptLoaded(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      return resolve();
    }

    if (window.google?.accounts) {
      return resolve();
    }

    const existingScript = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve());
      existingScript.addEventListener('error', () =>
        reject(new Error('Failed to load Google Identity Services client script.'))
      );
      // In case it finished loading just before the event listener was attached
      if (window.google?.accounts) {
        return resolve();
      }
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Google Identity Services script failed to load. Check your network or ad-blocker settings.'));
    document.head.appendChild(script);
  });
}

export const authService = {
  subscribe(listener: AuthListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getCurrentUser(): UserProfile | null {
    try {
      const raw = localStorage.getItem(USER_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  getGoogleClientId(): string {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(CUSTOM_CLIENT_ID_KEY);
      if (stored && stored.trim()) return stored.trim();
      if (window.__LOCORA_GOOGLE_CLIENT_ID__ && window.__LOCORA_GOOGLE_CLIENT_ID__.trim()) {
        return window.__LOCORA_GOOGLE_CLIENT_ID__.trim();
      }
    }

    // Injected at build time by vite.config.ts from Vercel's GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_ID
    if (typeof __GOOGLE_CLIENT_ID__ !== 'undefined' && __GOOGLE_CLIENT_ID__ && __GOOGLE_CLIENT_ID__.trim()) {
      return __GOOGLE_CLIENT_ID__.trim();
    }

    try {
      const envId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;
      if (envId && typeof envId === 'string' && envId.trim()) {
        return envId.trim();
      }
    } catch {
      // ignore
    }

    return '';
  },

  setCustomGoogleClientId(id: string): void {
    if (typeof window !== 'undefined') {
      if (!id || !id.trim()) {
        localStorage.removeItem(CUSTOM_CLIENT_ID_KEY);
      } else {
        localStorage.setItem(CUSTOM_CLIENT_ID_KEY, id.trim());
      }
    }
  },

  isGoogleConfigured(): boolean {
    return Boolean(this.getGoogleClientId());
  },

  /**
   * Process a Google Credential JWT from Google Identity Services button or OneTap
   */
  async loginWithGoogleCredential(credentialJwt: string, role: 'attendee' | 'organizer' = 'attendee'): Promise<UserProfile> {
    const payload = parseJwtPayload(credentialJwt);
    if (!payload || !payload.email) {
      throw new Error('Invalid or corrupted Google credential payload.');
    }

    const userProfile: UserProfile = {
      id: payload.sub ? `google-${payload.sub}` : `usr-${Date.now()}`,
      name: payload.name || payload.given_name || 'Community Member',
      email: payload.email,
      avatar:
        payload.picture ||
        'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
      bio: role === 'organizer' ? 'Community organizer on Locora.' : 'Local resident and active event attendee.',
      neighborhood: 'Downtown Arts District',
      interests: ['Food & Community', 'Live Music & Culture'],
      role,
      createdAt: new Date().toISOString(),
    };

    // Store session locally
    localStorage.setItem(TOKEN_STORAGE_KEY, credentialJwt);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userProfile));

    // Sync to backend if accessible
    if (!isDemoMode()) {
      try {
        await apiClient.post('/auth/google', {
          id: userProfile.id,
          name: userProfile.name,
          email: userProfile.email,
          avatar: userProfile.avatar,
          role: userProfile.role,
        });
      } catch (err) {
        console.warn('Backend sync for Google user skipped:', err);
      }
    }

    notify(userProfile);
    return userProfile;
  },

  /**
   * Triggers direct Google OAuth 2.0 popup without Firebase Auth.
   * Uses Google Identity Services Token Client.
   */
  async loginWithGoogle(role: 'attendee' | 'organizer' = 'attendee'): Promise<UserProfile> {
    await ensureGoogleIdentityScriptLoaded();

    const clientId = this.getGoogleClientId();
    if (!clientId) {
      throw new Error(
        'GOOGLE_CLIENT_ID_NOT_CONFIGURED: Google Client ID is missing. Add GOOGLE_CLIENT_ID to your Vercel Environment Variables or .env file.'
      );
    }

    if (!window.google?.accounts?.oauth2) {
      throw new Error('Google Identity Services SDK is not available in this browser window.');
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;

      try {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'openid email profile',
          callback: async (tokenResponse: any) => {
            if (isSettled) return;
            isSettled = true;

            if (tokenResponse.error) {
              if (tokenResponse.error === 'access_denied') {
                return reject(new Error('Sign-in cancelled: Access was denied.'));
              }
              if (tokenResponse.error === 'popup_closed_by_user') {
                return reject(new Error('Sign-in window was closed before completing authentication.'));
              }
              return reject(new Error(tokenResponse.error_description || tokenResponse.error || 'Google sign-in failed.'));
            }

            if (!tokenResponse.access_token) {
              return reject(new Error('No access token received from Google.'));
            }

            try {
              // Retrieve user profile directly from Google's UserInfo API
              const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: {
                  Authorization: `Bearer ${tokenResponse.access_token}`,
                },
              });

              if (!res.ok) {
                throw new Error(`Google profile request failed with status: ${res.status}`);
              }

              const info = await res.json();
              const userProfile: UserProfile = {
                id: info.sub ? `google-${info.sub}` : `usr-${Date.now()}`,
                name: info.name || info.given_name || 'Community Member',
                email: info.email,
                avatar:
                  info.picture ||
                  'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
                bio: role === 'organizer' ? 'Community organizer in Metro City.' : 'Local resident and active event attendee.',
                neighborhood: 'Downtown Arts District',
                interests: ['Food & Community', 'Live Music & Culture'],
                role,
                createdAt: new Date().toISOString(),
              };

              localStorage.setItem(TOKEN_STORAGE_KEY, tokenResponse.access_token);
              localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userProfile));

              // Persist to backend if available
              if (!isDemoMode()) {
                try {
                  await apiClient.post('/auth/google', {
                    id: userProfile.id,
                    name: userProfile.name,
                    email: userProfile.email,
                    avatar: userProfile.avatar,
                    role: userProfile.role,
                  });
                } catch (e) {
                  console.warn('Backend sync for Google user skipped:', e);
                }
              }

              notify(userProfile);
              resolve(userProfile);
            } catch (fetchErr: any) {
              reject(new Error(fetchErr.message || 'Failed to fetch Google profile details.'));
            }
          },
          error_callback: (err: any) => {
            if (isSettled) return;
            isSettled = true;
            if (err.type === 'popup_blocked') {
              reject(new Error('Google sign-in popup was blocked by your browser. Please allow popups for this site.'));
            } else if (err.type === 'popup_closed') {
              reject(new Error('Google sign-in window was closed.'));
            } else {
              reject(new Error(err.message || 'Google authentication error.'));
            }
          },
        });

        // Trigger Google OAuth popup
        client.requestAccessToken({ prompt: 'consent' });
      } catch (err: any) {
        if (!isSettled) {
          isSettled = true;
          reject(new Error(err.message || 'Failed to initialize Google Sign-In client.'));
        }
      }
    });
  },

  async login(email: string, _password?: string): Promise<UserProfile> {
    if (!isDemoMode()) {
      try {
        const res = await apiClient.post<{ user: UserProfile; token: string }>('/auth/login', {
          email,
          password: _password,
        });
        localStorage.setItem(TOKEN_STORAGE_KEY, res.token);
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(res.user));
        notify(res.user);
        return res.user;
      } catch (err) {
        console.warn('Backend API login unavailable, falling back to local session:', err);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    let user = DEFAULT_DEMO_USER;
    if (email.includes('org') || email.includes('civictech') || email.includes('marcus')) {
      user = DEFAULT_DEMO_ORGANIZER_USER;
    } else {
      user = {
        ...DEFAULT_DEMO_USER,
        email: email || DEFAULT_DEMO_USER.email,
      };
    }

    localStorage.setItem(TOKEN_STORAGE_KEY, 'demo_jwt_token_locora_preview');
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    notify(user);
    return user;
  },

  async signup(name: string, email: string, role: 'attendee' | 'organizer' = 'attendee'): Promise<UserProfile> {
    if (!isDemoMode()) {
      try {
        const res = await apiClient.post<{ user: UserProfile; token: string }>('/auth/signup', { name, email, role });
        localStorage.setItem(TOKEN_STORAGE_KEY, res.token);
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(res.user));
        notify(res.user);
        return res.user;
      } catch (err) {
        console.warn('Backend API signup unavailable, falling back to local session:', err);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    const newUser: UserProfile = {
      id: `usr-${Date.now()}`,
      name,
      email,
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
      bio: role === 'organizer' ? 'Community organizer in Metro City.' : 'Local resident and active event attendee.',
      neighborhood: 'Downtown Arts District',
      interests: ['Food & Community', 'Live Music & Culture'],
      role,
      createdAt: new Date().toISOString(),
    };

    localStorage.setItem(TOKEN_STORAGE_KEY, 'demo_jwt_token_locora_preview');
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(newUser));
    notify(newUser);
    return newUser;
  },

  async logout(): Promise<void> {
    localStorage.removeItem(USER_STORAGE_KEY);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    notify(null);
  },

  quickSwitchUser(role: 'attendee' | 'organizer' | 'guest'): void {
    if (role === 'guest') {
      localStorage.removeItem(USER_STORAGE_KEY);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      notify(null);
    } else if (role === 'organizer') {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_DEMO_ORGANIZER_USER));
      localStorage.setItem(TOKEN_STORAGE_KEY, 'demo_token_org');
      notify(DEFAULT_DEMO_ORGANIZER_USER);
    } else {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_DEMO_USER));
      localStorage.setItem(TOKEN_STORAGE_KEY, 'demo_token_attendee');
      notify(DEFAULT_DEMO_USER);
    }
  },

  async updateProfile(updates: Partial<UserProfile>): Promise<UserProfile> {
    if (!isDemoMode()) {
      try {
        const updated = await apiClient.patch<UserProfile>('/me', updates);
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated));
        notify(updated);
        return updated;
      } catch (err) {
        console.warn('Backend updateProfile failed, falling back to local update:', err);
      }
    }

    const current = this.getCurrentUser();
    if (!current) throw new Error('Not authenticated');

    const updated = { ...current, ...updates };
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated));
    notify(updated);
    return updated;
  },
};
