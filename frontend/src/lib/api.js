import axios from "axios";
import { createContext, useContext, useMemo, useRef } from "react";

const rawBackend = (process.env.REACT_APP_BACKEND_URL || "").trim().replace(/\/+$/, "");
export const API = rawBackend ? `${rawBackend}/api` : "/api";

const LDAP_KEY = "cadence_ldap_token";
export const ldapToken = () => localStorage.getItem(LDAP_KEY);
export const setLdapToken = (t) => (t ? localStorage.setItem(LDAP_KEY, t) : localStorage.removeItem(LDAP_KEY));

export const ClerkTokenContext = createContext(null);

export function useTokenGetter() {
  const clerkGetToken = useContext(ClerkTokenContext);
  const ref = useRef(clerkGetToken);
  ref.current = clerkGetToken;
  return useMemo(() => async () => ldapToken() || (ref.current ? await ref.current() : null), []);
}

export function useApi() {
  const getToken = useTokenGetter();
  const ref = useRef(getToken);
  ref.current = getToken;
  return useMemo(() => {
    const c = axios.create({ baseURL: API });
    c.interceptors.request.use(async (cfg) => {
      const t = await ref.current();
      if (t) cfg.headers.Authorization = `Bearer ${t}`;
      return cfg;
    });
    return c;
  }, []);
}

export const errMsg = (e) => e?.response?.data?.detail?.toString?.() || e?.message || "Something went wrong";

export async function streamSSE(path, body, token, onEvent) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    parts.filter((p) => p.startsWith("data: ")).forEach((p) => onEvent(JSON.parse(p.slice(6))));
  }
}
