import { createContext, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClerkProvider, useAuth } from "@clerk/react";
import { ClerkTokenContext } from "@/lib/api";

const appearance = {
  variables: { colorPrimary: "#1B3F94", colorForeground: "#14306F", fontFamily: "Open Sans, sans-serif", borderRadius: "0.5rem" },
};

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || "").trim().replace(/\/+$/, "");
const ClerkConfigContext = createContext({ enabled: false, loading: true });

export const useClerkConfig = () => useContext(ClerkConfigContext);

function ClerkTokenBridge({ children }) {
  const { getToken } = useAuth();
  return (
    <ClerkTokenContext.Provider value={getToken}>
      {children}
    </ClerkTokenContext.Provider>
  );
}

// Starts Clerk from the backend's runtime config, so deploy's live keys need no rebuild.
// Must render inside <BrowserRouter> (see step 3) so Clerk navigates without reloading.
export default function ClerkAuthProvider({ children }) {
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [unavailable, setUnavailable] = useState(false);

  // Retries while the backend restarts (e.g. right after provisioning): the app's
  // Clerk components crash if they ever render without <ClerkProvider>.
  useEffect(() => {
    let cancelled = false;
    const load = async (attempt = 0) => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/clerk/config`);
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.enabled) return cancelled || setConfig(cfg);
          if (cfg.enabled === false) return cancelled || setConfig({ enabled: false });
        }
      } catch {}
      if (cancelled) return;
      if (attempt >= 5) return setConfig({ enabled: false });
      setTimeout(() => load(attempt + 1), 1000);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  if (unavailable) return <p style={{ padding: 24 }}>Sign-in is unavailable right now. Refresh the page to try again.</p>;
  if (!config) return null;

  return (
    <ClerkConfigContext.Provider value={{ enabled: !!config.enabled, loading: false }}>
      {config.enabled ? (
        <ClerkProvider
          publishableKey={config.publishable_key}
          proxyUrl={config.proxy_url || undefined}
          appearance={appearance}
          routerPush={(to) => navigate(to)}
          routerReplace={(to) => navigate(to, { replace: true })}
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/"
          signUpFallbackRedirectUrl="/"
          afterSignOutUrl="/"
        >
          <ClerkTokenBridge>
            {children}
          </ClerkTokenBridge>
        </ClerkProvider>
      ) : (
        <ClerkTokenContext.Provider value={null}>
          {children}
        </ClerkTokenContext.Provider>
      )}
    </ClerkConfigContext.Provider>
  );
}
