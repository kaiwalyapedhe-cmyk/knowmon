import axios from "axios";
import { useMemo, useRef } from "react";
import { useAuth } from "@clerk/react";

export const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export function useApi() {
  const { getToken } = useAuth();
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
