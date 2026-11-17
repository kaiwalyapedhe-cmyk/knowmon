import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { API, errMsg, setLdapToken } from "@/lib/api";
import { Field } from "@/components/common";

function useLdapEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { axios.get(`${API}/auth/ldap/config`).then((r) => setEnabled(r.data.enabled)).catch(() => {}); }, []);
  return enabled;
}

export function CompanyLoginLink() {
  const enabled = useLdapEnabled();
  if (!enabled) return null;
  return (
    <Link to="/ldap-login" data-testid="company-login-link" className="inline-flex items-center gap-2 rounded-full border border-[#1B3F94]/30 bg-white px-4 py-2 text-sm font-semibold text-[#1B3F94] hover:border-[#E31E24] hover:text-[#E31E24]">
      <Building2 className="h-4 w-4" /> Sign in with company login (LDAP)
    </Link>
  );
}

export default function LdapLogin() {
  const nav = useNavigate();
  const enabled = useLdapEnabled();
  const [f, setF] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await axios.post(`${API}/auth/ldap/login`, f);
      setLdapToken(r.data.token);
      nav("/dashboard", { replace: true });
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  };
  return (
    <div className="grid-bg flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card-surface w-full max-w-sm space-y-5 border-t-4 border-t-[#E31E24] p-8" data-testid="ldap-login-form">
        <div>
          <div className="font-display text-2xl font-extrabold"><span className="text-[#1B3F94]">Cadence</span><span className="text-[#E31E24]">CX</span></div>
          <h1 className="mt-3 text-xl font-bold">Company login</h1>
          <p className="text-sm text-slate-500">Use your network (LDAP / Active Directory) username and password.</p>
        </div>
        {!enabled && <p className="text-sm text-amber-700" data-testid="ldap-disabled-note">Company login hasn't been set up yet. Use the regular sign-in.</p>}
        <Field label="Username or email"><Input autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} data-testid="ldap-username-input" /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="ldap-password-input" /></Field>
        {error && <p className="text-sm text-red-600" data-testid="ldap-error">{error}</p>}
        <Button type="submit" className="w-full" disabled={!enabled || busy || !f.username || !f.password} data-testid="ldap-submit-btn">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Sign in
        </Button>
        <Link to="/sign-in" className="block text-center text-sm text-slate-500 hover:text-[#1B3F94]" data-testid="ldap-back-to-signin">Use email or Google instead</Link>
      </form>
    </div>
  );
}
