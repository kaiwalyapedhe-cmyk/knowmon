import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Mail, Network, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { PageHeader, fmtDate } from "@/components/common";

function Status({ ok, label, hint, testId }) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      {ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /> : <XCircle className="mt-0.5 h-5 w-5 text-red-600" />}
      <div><div className="font-semibold">{label}: {ok ? "connected" : "not set up"}</div><div className="text-xs text-slate-500">{hint}</div></div>
    </div>
  );
}

export default function Settings() {
  const api = useApi();
  const { isAdmin } = useMe();
  const [d, setD] = useState(null);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get("/digest/preview").then((r) => setD(r.data));
    api.get("/digest/logs").then((r) => setLogs(r.data));
  }, [api]);
  useEffect(() => { if (isAdmin) load(); }, [load, isAdmin]);
  const sendNow = async () => {
    setBusy(true);
    try { const r = await api.post("/digest/send"); r.data.status === "sent" ? toast.success(`Digest sent to ${r.data.recipients.length} team lead(s)`) : toast.error(r.data.error); load(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  if (!isAdmin) return <p className="text-slate-500">Admins only.</p>;
  if (!d) return <div className="label-mono">Loading…</div>;
  return (
    <div>
      <PageHeader eyebrow="Daily QA digest" title="Digest & Directory" desc={`${d.schedule}. Goes to every team lead — people with the Team Lead role here plus members of your directory's team lead group.`}>
        <Button onClick={sendNow} disabled={busy} data-testid="digest-send-now-btn">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}Send today's digest now</Button>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-4">
          <div className="card-surface space-y-4 p-6">
            <Status ok={d.smtp_configured} label="Email (SMTP)" hint="Your mail server sends the digest." testId="smtp-status" />
            <Status ok={d.ldap_enabled} label="Directory (LDAP)" hint="Company login and team lead lookup." testId="ldap-status" />
          </div>
          <div className="card-surface p-6" data-testid="digest-recipients">
            <div className="label-mono mb-3 flex items-center gap-2"><Mail className="h-4 w-4" />Recipients ({d.recipients.length})</div>
            {d.recipients.length ? d.recipients.map((e) => <div key={e} className="py-0.5 text-sm">{e}</div>) : <p className="text-sm text-slate-500">No team leads yet. Give someone the Team Lead role on the Users page or add them to the directory group.</p>}
          </div>
          <div className="card-surface p-6" data-testid="digest-logs">
            <div className="label-mono mb-3 flex items-center gap-2"><Network className="h-4 w-4" />Recent sends</div>
            {logs.length === 0 && <p className="text-sm text-slate-500">Nothing sent yet.</p>}
            {logs.map((l) => (
              <div key={l.id} className="border-t border-slate-200 py-2 text-xs">
                <span className={l.status === "sent" ? "font-semibold text-emerald-600" : "font-semibold text-red-600"}>{l.status}</span> · {l.trigger} · {fmtDate(l.at)}
                {l.error && <div className="text-red-600">{l.error}</div>}
              </div>
            ))}
          </div>
        </div>
        <div className="card-surface overflow-hidden lg:col-span-8">
          <div className="label-mono border-b border-slate-200 px-6 py-3">Preview · {d.subject}</div>
          <iframe title="Digest preview" srcDoc={d.html} className="h-[640px] w-full bg-white" data-testid="digest-preview-frame" />
        </div>
      </div>
    </div>
  );
}
