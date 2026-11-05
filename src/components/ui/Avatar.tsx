import React, { useEffect, useState } from 'react';

// Avatar with a graceful fallback. A stored profile-picture URL can go
// dead — Google picture URLs 404 once the user changes their Google
// photo, and the app only refreshes the stored URL at Google sign-in,
// so a long-lived session can keep serving a stale URL. A bare <img>
// then shows the browser's broken-image icon (and the raw name as alt
// text) instead of a face. This renders the photo while it loads, and
// swaps to the same initial-letter circle the "Posted by" card already
// uses when the URL is empty or fails to load. className (size, shape,
// border) is applied to both the photo and the fallback circle;
// initialClassName sizes the letter.
export default function Avatar({
  src,
  name,
  className = '',
  initialClassName = 'text-lg',
}: {
  src?: string | null;
  name?: string | null;
  className?: string;
  initialClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const url = (src || '').trim();
  if (!url || failed) {
    return (
      <div
        aria-hidden="true"
        className={`${className} bg-[#1E3F35] text-white flex items-center justify-center font-editorial font-bold ${initialClassName}`}
      >
        {(name || '?').charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={name || 'Profile picture'}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
