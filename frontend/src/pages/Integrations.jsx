import { useEffect, useState } from "react";
import { 
  Network, Mail, Cpu, CheckCircle2, XCircle, Loader2, Save, Send, Eye, EyeOff, Plug2, Database, ShieldCheck 
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { PageHeader, Field, NativeSelect } from "@/components/common";

export default function Integrations() {
  const api = useApi();
  const { isAdmin } = useMe();
  const [activeTab, setActiveTab] = useState("ldap");
  const [loading, setLoading] = useState(true);

  // LDAP State
  const [ldap, setLdap] = useState({
    url: "",
    base_dn: "",
    bind_dn: "",
    bind_password: "",
    user_filter: "",
    team_lead_group_dn: "",
    has_password: false,
    enabled: false,
  });
  const [showLdapPw, setShowLdapPw] = useState(false);
  const [testingLdap, setTestingLdap] = useState(false);
  const [savingLdap, setSavingLdap] = useState(false);
  const [ldapTestResult, setLdapTestResult] = useState(null);

  // SMTP State
  const [smtp, setSmtp] = useState({
    host: "",
    port: 587,
    security: "starttls",
    username: "",
    password: "",
    from_address: "",
    has_password: false,
    configured: false,
  });
  const [showSmtpPw, setShowSmtpPw] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState(null);

  // Load config
  const fetchConfig = async () => {
    try {
      setLoading(true);
      const res = await api.get("/integrations");
      if (res.data) {
        setLdap((prev) => ({
          ...prev,
          ...res.data.ldap,
          bind_password: "",
        }));
        setSmtp((prev) => ({
          ...prev,
          ...res.data.smtp,
          password: "",
        }));
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) fetchConfig();
  }, [isAdmin]);

  // Save LDAP
  const handleSaveLdap = async (e) => {
    e.preventDefault();
    setSavingLdap(true);
    try {
      const payload = {
        url: ldap.url,
        base_dn: ldap.base_dn,
        bind_dn: ldap.bind_dn,
        user_filter: ldap.user_filter,
        team_lead_group_dn: ldap.team_lead_group_dn,
      };
      if (ldap.bind_password) payload.bind_password = ldap.bind_password;
      await api.post("/integrations/ldap", payload);
      toast.success("LDAP Directory settings saved successfully!");
      fetchConfig();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSavingLdap(false);
    }
  };

  // Test LDAP
  const handleTestLdap = async () => {
    if (!ldap.url || !ldap.base_dn) {
      toast.error("Please enter both LDAP Server URL and Base DN before testing.");
      return;
    }
    setTestingLdap(true);
    setLdapTestResult(null);
    try {
      const res = await api.post("/integrations/ldap/test", {
        url: ldap.url,
        base_dn: ldap.base_dn,
        bind_dn: ldap.bind_dn,
        bind_password: ldap.bind_password,
        user_filter: ldap.user_filter,
      });
      setLdapTestResult({ ok: true, message: res.data.message });
      toast.success("LDAP Connection test passed!");
    } catch (e) {
      const err = errMsg(e);
      setLdapTestResult({ ok: false, error: err });
      toast.error(`LDAP test failed: ${err}`);
    } finally {
      setTestingLdap(false);
    }
  };

  // Save SMTP
  const handleSaveSmtp = async (e) => {
    e.preventDefault();
    setSavingSmtp(true);
    try {
      const payload = {
        host: smtp.host,
        port: parseInt(smtp.port, 10) || 587,
        security: smtp.security,
        username: smtp.username,
        from_address: smtp.from_address,
      };
      if (smtp.password) payload.password = smtp.password;
      await api.post("/integrations/smtp", payload);
      toast.success("SMTP Email settings saved successfully!");
      fetchConfig();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSavingSmtp(false);
    }
  };

  // Test SMTP
  const handleTestSmtp = async () => {
    if (!smtp.host || !smtp.from_address || !testRecipient) {
      toast.error("Please provide SMTP Host, From Address, and a Test Recipient email.");
      return;
    }
    setTestingSmtp(true);
    setSmtpTestResult(null);
    try {
      const res = await api.post("/integrations/smtp/test", {
        host: smtp.host,
        port: parseInt(smtp.port, 10) || 587,
        security: smtp.security,
        username: smtp.username,
        password: smtp.password,
        from_address: smtp.from_address,
        recipient: testRecipient,
      });
      setSmtpTestResult({ ok: true, message: res.data.message });
      toast.success("Test email delivered successfully!");
    } catch (e) {
      const err = errMsg(e);
      setSmtpTestResult({ ok: false, error: err });
      toast.error(`SMTP test failed: ${err}`);
    } finally {
      setTestingSmtp(false);
    }
  };

  if (!isAdmin) return <p className="p-8 text-slate-500">Admins only.</p>;
  if (loading) return <div className="p-8 label-mono">Loading integrations…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Enterprise Settings"
        title="Integrations & Connectors"
        desc="Manage enterprise directory authentication, mail dispatch servers, AI evaluation pipelines, and external CRM connectors."
      />

      {/* Tabs Header */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab("ldap")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
            activeTab === "ldap"
              ? "bg-[#1B3F94] text-white shadow"
              : "bg-white text-slate-600 hover:bg-slate-100 hover:text-[#1B3F94]"
          }`}
        >
          <Network className="h-4 w-4" />
          <span>Active Directory / LDAP</span>
          {ldap.enabled ? (
            <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          ) : (
            <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-slate-300" />
          )}
        </button>

        <button
          onClick={() => setActiveTab("smtp")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
            activeTab === "smtp"
              ? "bg-[#1B3F94] text-white shadow"
              : "bg-white text-slate-600 hover:bg-slate-100 hover:text-[#1B3F94]"
          }`}
        >
          <Mail className="h-4 w-4" />
          <span>Email (SMTP)</span>
          {smtp.configured ? (
            <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          ) : (
            <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-slate-300" />
          )}
        </button>

        <button
          onClick={() => setActiveTab("ai")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
            activeTab === "ai"
              ? "bg-[#1B3F94] text-white shadow"
              : "bg-white text-slate-600 hover:bg-slate-100 hover:text-[#1B3F94]"
          }`}
        >
          <Cpu className="h-4 w-4" />
          <span>AI & Speech Models</span>
          <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </button>

        <button
          onClick={() => setActiveTab("crm")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
            activeTab === "crm"
              ? "bg-[#1B3F94] text-white shadow"
              : "bg-white text-slate-600 hover:bg-slate-100 hover:text-[#1B3F94]"
          }`}
        >
          <Plug2 className="h-4 w-4" />
          <span>CRM & Ticketing</span>
        </button>
      </div>

      {/* LDAP Tab */}
      {activeTab === "ldap" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="card-surface space-y-5 p-6 lg:col-span-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">LDAP & Active Directory Configuration</h2>
                <p className="text-xs text-slate-500">
                  Enables single sign-on for contact center staff and automatically discovers Team Leads.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {ldap.enabled ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Active
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 border border-amber-200">
                    <XCircle className="h-3.5 w-3.5" /> Not Configured
                  </span>
                )}
              </div>
            </div>

            <form onSubmit={handleSaveLdap} className="space-y-4">
              <Field label="Directory Server URL">
                <Input
                  placeholder="ldap://corp-ad.jsw.in:389 or ldaps://corp-ad.jsw.in:636"
                  value={ldap.url}
                  onChange={(e) => setLdap({ ...ldap, url: e.target.value })}
                  required
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Search Base DN">
                  <Input
                    placeholder="DC=corp,DC=jsw,DC=in"
                    value={ldap.base_dn}
                    onChange={(e) => setLdap({ ...ldap, base_dn: e.target.value })}
                    required
                  />
                </Field>

                <Field label="Service Account Bind DN (Optional)">
                  <Input
                    placeholder="CN=svc-cadence,OU=ServiceAccounts,DC=corp..."
                    value={ldap.bind_dn}
                    onChange={(e) => setLdap({ ...ldap, bind_dn: e.target.value })}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Service Account Password">
                  <div className="relative">
                    <Input
                      type={showLdapPw ? "text" : "password"}
                      placeholder={ldap.has_password ? "•••••••••••• (leave empty to keep current)" : "Enter password"}
                      value={ldap.bind_password}
                      onChange={(e) => setLdap({ ...ldap, bind_password: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowLdapPw(!showLdapPw)}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                    >
                      {showLdapPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>

                <Field label="User Search Filter (Optional)">
                  <Input
                    placeholder="(|(uid={u})(sAMAccountName={u})(mail={u}))"
                    value={ldap.user_filter}
                    onChange={(e) => setLdap({ ...ldap, user_filter: e.target.value })}
                  />
                </Field>
              </div>

              <Field label="Team Lead Group DN (Optional)">
                <Input
                  placeholder="CN=TeamLeads,OU=Security Groups,DC=corp,DC=jsw,DC=in"
                  value={ldap.team_lead_group_dn}
                  onChange={(e) => setLdap({ ...ldap, team_lead_group_dn: e.target.value })}
                />
                <span className="text-[11px] text-slate-500">
                  Users matching this group are automatically assigned the Team Lead role and receive daily digests.
                </span>
              </Field>

              {ldapTestResult && (
                <div
                  className={`rounded-lg p-3 text-xs flex items-start gap-2 border ${
                    ldapTestResult.ok
                      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                      : "bg-red-50 text-red-800 border-red-200"
                  }`}
                >
                  {ldapTestResult.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="font-semibold">{ldapTestResult.ok ? "Test Succeeded" : "Test Failed"}</div>
                    <div>{ldapTestResult.message || ldapTestResult.error}</div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTestLdap}
                  disabled={testingLdap || savingLdap}
                >
                  {testingLdap ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  Test Directory Connection
                </Button>

                <Button type="submit" disabled={savingLdap || testingLdap} className="bg-[#1B3F94] hover:bg-[#153277]">
                  {savingLdap ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save LDAP Configuration
                </Button>
              </div>
            </form>
          </div>

          <div className="space-y-4 lg:col-span-4">
            <div className="card-surface space-y-3 p-5">
              <h3 className="flex items-center gap-2 font-bold text-slate-900">
                <Database className="h-4 w-4 text-[#1B3F94]" /> LDAP SSO Workflow
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                When enabled, employees can sign in using their network credentials at <code>/ldap-login</code>.
              </p>
              <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-4">
                <li>Issues a 12-hour signed JWT session.</li>
                <li>Temporary lockout after 5 consecutive failed attempts.</li>
                <li>Admin email addresses in <code>ADMIN_EMAIL</code> automatically receive Admin privileges.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* SMTP Tab */}
      {activeTab === "smtp" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="card-surface space-y-5 p-6 lg:col-span-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Email Server (SMTP) Configuration</h2>
                <p className="text-xs text-slate-500">
                  Sends scheduled evening Quality digests to team leads and coaching alerts.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {smtp.configured ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Configured
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 border border-amber-200">
                    <XCircle className="h-3.5 w-3.5" /> Not Configured
                  </span>
                )}
              </div>
            </div>

            <form onSubmit={handleSaveSmtp} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Field label="SMTP Server Host">
                    <Input
                      placeholder="smtp.office365.com or smtp.gmail.com"
                      value={smtp.host}
                      onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
                      required
                    />
                  </Field>
                </div>

                <Field label="Port">
                  <Input
                    type="number"
                    placeholder="587"
                    value={smtp.port}
                    onChange={(e) => setSmtp({ ...smtp, port: e.target.value })}
                    required
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Security Protocol">
                  <NativeSelect
                    value={smtp.security}
                    onChange={(val) => setSmtp({ ...smtp, security: val })}
                    options={[
                      { value: "starttls", label: "STARTTLS (Standard on Port 587)" },
                      { value: "ssl", label: "SSL / TLS (Port 465)" },
                      { value: "none", label: "None / Plain (Internal Relay Port 25)" },
                    ]}
                  />
                </Field>

                <Field label="Sender (From Address)">
                  <Input
                    placeholder="Cadence CX <notifications@jswshakti.in>"
                    value={smtp.from_address}
                    onChange={(e) => setSmtp({ ...smtp, from_address: e.target.value })}
                    required
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="SMTP Username / Account Email">
                  <Input
                    placeholder="notifications@jswshakti.in"
                    value={smtp.username}
                    onChange={(e) => setSmtp({ ...smtp, username: e.target.value })}
                  />
                </Field>

                <Field label="SMTP Password / App Password">
                  <div className="relative">
                    <Input
                      type={showSmtpPw ? "text" : "password"}
                      placeholder={smtp.has_password ? "•••••••••••• (leave empty to keep current)" : "Enter password"}
                      value={smtp.password}
                      onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSmtpPw(!showSmtpPw)}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                    >
                      {showSmtpPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="label-mono flex items-center gap-1.5 text-slate-700">
                  <Send className="h-3.5 w-3.5" /> Test Dispatch
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter test recipient email (e.g. you@company.com)"
                    value={testRecipient}
                    onChange={(e) => setTestRecipient(e.target.value)}
                    className="bg-white"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestSmtp}
                    disabled={testingSmtp || savingSmtp || !testRecipient}
                  >
                    {testingSmtp && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Send Test Email
                  </Button>
                </div>
                {smtpTestResult && (
                  <div
                    className={`rounded-lg p-2.5 text-xs flex items-center gap-2 border ${
                      smtpTestResult.ok
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                        : "bg-red-50 text-red-800 border-red-200"
                    }`}
                  >
                    {smtpTestResult.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-600 shrink-0" />
                    )}
                    <span>{smtpTestResult.message || smtpTestResult.error}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-end pt-3">
                <Button type="submit" disabled={savingSmtp || testingSmtp} className="bg-[#1B3F94] hover:bg-[#153277]">
                  {savingSmtp ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save SMTP Configuration
                </Button>
              </div>
            </form>
          </div>

          <div className="space-y-4 lg:col-span-4">
            <div className="card-surface space-y-3 p-5">
              <h3 className="flex items-center gap-2 font-bold text-slate-900">
                <Mail className="h-4 w-4 text-[#1B3F94]" /> Automated Digest
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                The QA system automatically runs at <strong>8:00 PM IST</strong> every evening, compiles the day's evaluations, lowest scores, auto-fails, and open disputes, and sends an HTML digest to all team leads.
              </p>
              <p className="text-xs text-slate-500">
                You can also preview and manually trigger digests on the <strong>Digest & Directory</strong> page.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* AI Tab */}
      {activeTab === "ai" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="card-surface space-y-5 p-6 lg:col-span-8">
            <h2 className="text-lg font-bold text-slate-900 border-b border-slate-100 pb-3">AI & Speech Analytics Engines</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-4 space-y-2">
                <div className="label-mono text-[#1B3F94]">Quality Assurance & Copilot LLM</div>
                <div className="text-base font-bold">Claude Opus 5.5</div>
                <p className="text-xs text-slate-500">
                  Scores omnichannel customer interactions against criteria, analyzes sentiment, predicts CSAT, and detects compliance violations with quote citations.
                </p>
                <div className="flex items-center gap-1.5 pt-2 text-xs text-emerald-600 font-semibold">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Engine Active
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-4 space-y-2">
                <div className="label-mono text-[#1B3F94]">Audio Speech-To-Text</div>
                <div className="text-base font-bold">OpenAI Whisper-1</div>
                <p className="text-xs text-slate-500">
                  Generates timestamped transcripts for call audio uploads, powering click-to-seek playback and quote verification.
                </p>
                <div className="flex items-center gap-1.5 pt-2 text-xs text-emerald-600 font-semibold">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Transcriber Active
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CRM Tab */}
      {activeTab === "crm" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="card-surface space-y-5 p-6 lg:col-span-8">
            <h2 className="text-lg font-bold text-slate-900 border-b border-slate-100 pb-3">CRM & Ticketing Connectors</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 p-4 space-y-2 bg-slate-50/50">
                <div className="font-bold">Salesforce Service Cloud</div>
                <p className="text-xs text-slate-500">Import call recordings and ticket threads automatically.</p>
                <span className="inline-block rounded bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Roadmap</span>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 space-y-2 bg-slate-50/50">
                <div className="font-bold">Zendesk Support</div>
                <p className="text-xs text-slate-500">Two-way ticket sync and QA score push to Zendesk tickets.</p>
                <span className="inline-block rounded bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Roadmap</span>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 space-y-2 bg-slate-50/50">
                <div className="font-bold">Freshdesk</div>
                <p className="text-xs text-slate-500">Webhook-based conversation ingestion and audit status updates.</p>
                <span className="inline-block rounded bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Roadmap</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
