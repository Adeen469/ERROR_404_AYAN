import React from 'react';
import { useLocation } from 'react-router-dom';

// Catches a render crash in any page and shows a readable card instead
// of a blank white page. Without this, one bad identifier (the
// Attendees page once rendered an `evt` variable that only existed
// inside its data loader) unmounts the whole React tree — navbar,
// footer and all — and the user sees nothing at all.
//
// The boundary resets on every route change (keyed by pathname), so a
// crash on one page does not poison navigation to every other page.

// Stale-chunk recovery, shared with App's lazyPage loader: after a
// redeploy, a still-open tab can request page chunks that no longer
// exist (the server answers with the SPA fallback HTML and the
// dynamic import fails). One guarded reload fetches the fresh shell
// and chunk map; the sessionStorage flag guarantees at most one
// automatic reload per tab session, so a genuinely broken build
// still lands on the error card instead of looping forever.
const CHUNK_RELOAD_KEY = 'locora-chunk-reload';

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|chunkloaderror/i.test(msg);
}

export function reloadOnceForChunkError(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false;
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1') return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    /* best-effort */
  }
}

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
};

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  componentDidCatch(err: unknown) {
    // A page chunk that vanished in a redeploy surfaces here during
    // render — recover with the one-shot reload instead of stranding
    // the user on this card (see reloadOnceForChunkError above).
    reloadOnceForChunkError(err);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-4">
        <h2 className="font-editorial text-2xl font-bold text-[#1E2320]">
          Something went wrong on this page
        </h2>
        <p className="text-sm text-[#5F635D]">
          Locora hit an unexpected error instead of showing this page.
          Reloading usually fixes it — if it keeps happening, please tell
          us which page you were opening.
        </p>
        {this.state.message && (
          <p className="text-[11px] text-[#8C887E] break-words">{this.state.message}</p>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
        >
          Reload page
        </button>
      </div>
    );
  }
}

export function PageErrorBoundary({ children }: Props) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}
