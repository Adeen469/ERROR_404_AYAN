import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { User, Check, AlertCircle, MapPin, Sparkles, LogOut } from 'lucide-react';
import { authService } from '../services/auth-service';
import { UserProfile, EventCategory } from '../types';
import { DEMO_CATEGORIES } from '../mocks/demo-data';
import { LocationPicker } from '../components/LocationPicker';
import { useToast } from '../components/ui/Toast';
import { isDemoMode } from '../services/api-client';
import {
  fetchAccess,
  requestOrganizerAccess,
  AccessRole,
} from '../services/roles-service';

export function ProfilePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const currentUser = authService.getCurrentUser();

  const [name, setName] = useState(currentUser?.name || '');
  const [email] = useState(currentUser?.email || '');
  // Mobile number: collected once by the attendee details gate before
  // a registration that requires details, and editable here any time.
  // Shared with event organizers only, on registrations that require it.
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [bio, setBio] = useState(currentUser?.bio || '');
  // Home location (Country -> State -> City) for "Near me" on Discover.
  const [homeLocation, setHomeLocation] = useState({
    country: currentUser?.country || '',
    state: currentUser?.state || '',
    city: currentUser?.city || '',
  });
  const [interests, setInterests] = useState<EventCategory[]>(
    currentUser?.interests || ['Food & Community', 'Live Music & Culture']
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Organizer access for this account, from the shared record. Admins and
  // approved organizers see their status; attendees can request access.
  const [accessRole, setAccessRole] = useState<AccessRole | null>(null);
  const [requestingAccess, setRequestingAccess] = useState(false);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    fetchAccess(currentUser.email).then((access) => {
      if (!cancelled) setAccessRole(access ? access.role : null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRequestAccess = async () => {
    if (!currentUser) return;
    setRequestingAccess(true);
    try {
      await requestOrganizerAccess(currentUser.email, currentUser.name);
      setAccessRole('pending');
      toast({
        type: 'success',
        title: 'Organizer request sent',
        description: 'An admin will review it. You will be able to post events once approved.',
      });
    } catch (err: unknown) {
      toast({
        type: 'error',
        title: 'Could not send the request',
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setRequestingAccess(false);
    }
  };

  const toggleInterest = (category: EventCategory) => {
    setInterests((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please provide a display name.');
      return;
    }
    if (interests.length === 0) {
      setError('Please select at least one interest to power your recommendations.');
      return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phone.trim() && (phoneDigits.length < 7 || phoneDigits.length > 15)) {
      setError('Please enter a valid mobile number (7–15 digits).');
      return;
    }
    setError('');
    setSaving(true);

    try {
      await authService.updateProfile({
        name: name.trim(),
        phone: phone.trim(),
        bio: bio.trim(),
        country: homeLocation.country,
        state: homeLocation.state,
        city: homeLocation.city,
        interests,
      });
      toast({
        type: 'success',
        title: 'Profile Updated',
        description: isDemoMode()
          ? 'Preferences saved to your local browser session.'
          : 'Your account settings were successfully updated.',
      });
    } catch {
      toast({
        type: 'error',
        title: 'Failed to update profile',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="pb-4 border-b border-[#E5E1D8]">
        <h1 className="font-editorial text-3xl font-bold tracking-tight text-[#1E2320]">
          Profile & Preferences
        </h1>
        <p className="text-sm text-[#5F635D] mt-1">
          Manage your personal information, home location, and SmartMatch topic preferences.
        </p>
      </div>

      {isDemoMode() && (
        <div className="p-4 bg-[#EAF1ED] border border-[#D0E2D9] rounded-xl text-xs text-[#1E3F35] flex items-start gap-2.5">
          <Sparkles className="w-4 h-4 text-[#1E3F35] shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Demo Session Persistence:</span> Any
            updates you save here will be reflected across your recommendations and local dashboard
            immediately.
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSaveProfile} className="space-y-6 bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs">
        {/* Basic Info */}
        <div className="space-y-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            Account Details
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Display Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-2.5 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                disabled
                value={email}
                className="w-full text-xs bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg p-2.5 text-[#8C887E] cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Mobile Number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. 9876543210"
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-2.5 text-[#1E2320] focus:border-[#1E3F35]"
              />
              <span className="text-[11px] text-[#8C887E]">
                Shared with event organizers only, when you register for events that require attendee details.
              </span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Bio / Community Note
            </label>
            <textarea
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell other attendees and organizers a bit about yourself..."
              className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-2.5 text-[#1E2320] focus:border-[#1E3F35]"
            />
          </div>
        </div>

        {/* Location Settings */}
        <div className="space-y-4 pt-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            Location Settings
          </h2>

          <LocationPicker
            mode="form"
            value={homeLocation}
            onChange={setHomeLocation}
          />
          <p className="text-[11px] text-[#5F635D]">
            Your home city powers the "Near me" filter on Discover and
            SmartMatch recommendations. When a state is selected, your city
            is also your neighborhood for matching.
          </p>
        </div>

        {/* Topic Interests */}
        <div className="space-y-4 pt-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            Interest Categories
          </h2>

          <div className="flex flex-wrap gap-2">
            {DEMO_CATEGORIES.map((cat) => {
              const selected = interests.includes(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleInterest(cat)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                    selected
                      ? 'bg-[#1E3F35] text-white shadow-2xs font-semibold'
                      : 'bg-white text-[#5F635D] border border-[#E2DFD8] hover:bg-[#F4F1EA] hover:text-[#1E2320]'
                  }`}
                >
                  {selected && <Check className="w-3.5 h-3.5" />}
                  <span>{cat}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Save & Sign Out CTA */}
        <div className="pt-6 border-t border-[#EBE7DF] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={async () => {
              await authService.logout();
              navigate('/');
              toast({
                type: 'info',
                title: 'Signed Out',
                description: 'You have been safely signed out.',
              });
            }}
            className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>

          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors shadow-xs cursor-pointer"
          >
            {saving ? 'Saving...' : 'Save Profile Changes'}
          </button>
        </div>
      </form>

      {/* Organizer access */}
      <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs space-y-4">
        <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
          Organizer Access
        </h2>
        <p className="text-xs text-[#5F635D] leading-relaxed">
          Only approved organizers can post events. Attendee accounts cannot
          post, and organizer access cannot be chosen at sign-up — it is
          granted by an admin after you request it.
        </p>
        {accessRole === 'admin' ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-xs text-[#1E3F35] font-medium">
              You are an admin. You can post events and review organizer requests.
            </p>
            <Link
              to="/admin"
              className="px-4 py-2.5 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
            >
              Open Admin Page
            </Link>
          </div>
        ) : accessRole === 'organizer' ? (
          <p className="text-xs text-[#1E3F35] font-medium">
            You are an approved organizer. You can post events from Organizer Hub.
          </p>
        ) : accessRole === 'pending' ? (
          <p className="text-xs text-[#1E3F35] font-medium">
            Your organizer request is pending. An admin will review it, and you
            will be able to post events once it is approved.
          </p>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-xs text-[#5F635D]">
              You are currently an attendee.
            </p>
            <button
              type="button"
              disabled={requestingAccess || !currentUser}
              onClick={handleRequestAccess}
              className="px-5 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors shadow-xs cursor-pointer"
            >
              {requestingAccess ? 'Sending…' : 'Request Organizer Access'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
