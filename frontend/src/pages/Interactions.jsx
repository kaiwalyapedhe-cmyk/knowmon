import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Loader2, Upload, Scale } from "lucide-react";
import { BulkImportDialog } from "@/components/BulkImportDialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { CHANNELS, ChannelTag, Empty, Field, NativeSelect, PageHeader, ScoreBadge, fmtDate } from "@/components/common";

const BUSY = ["transcribing", "scoring"];

function NewInteractionDialog({ open, onOpenChange, onCreated }) {
  const api = useApi();
  const { isStaff } = useMe();
  const [forms, setForms] = useState([]);
  const [people, setPeople] = useState([]);
  const [f, setF] = useState({ channel: "voice", form_id: "", agent_id: "", agent_name: "", customer_name: "", transcript: "" });
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("audio");
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!open) return;
    api.get("/qa-forms").then((r) => { setForms(r.data); setF((p) => ({ ...p, form_id: p.form_id || r.data[0]?.id || "" })); });
    if (isStaff) api.get("/people").then((r) => setPeople(r.data));
  }, [open, api, isStaff]);

  const submit = async () => {
    const fd = new FormData();
    Object.entries(f).forEach(([k, v]) => { if (k !== "transcript" || mode === "text") fd.append(k, v); });
    if (mode === "audio" && file) fd.append("file", file);
    setBusy(true);
    try {
      await api.post("/interactions", fd);
      toast.success("Submitted for AutoQA scoring");
      onCreated();
      onOpenChange(false);
      setFile(null);
      setF((p) => ({ ...p, transcript: "", customer_name: "" }));
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="new-interaction-dialog">
        <DialogHeader><DialogTitle>Evaluate an interaction</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel"><NativeSelect testId="interaction-channel-select" value={f.channel} onChange={set("channel")} options={CHANNELS} /></Field>
          <Field label="QA form"><NativeSelect testId="interaction-form-select" value={f.form_id} onChange={set("form_id")} options={forms.map((x) => ({ value: x.id, label: x.name }))} /></Field>
          {isStaff && (
            <Field label="Agent">
              <NativeSelect testId="interaction-agent-select" value={f.agent_id} onChange={set("agent_id")}
                options={[{ value: "", label: "Type a name…" }, ...people.map((p) => ({ value: p.user_id, label: `${p.name} (${p.email})` }))]} />
            </Field>
          )}
          {isStaff && !f.agent_id && (
            <Field label="Agent name"><Input data-testid="interaction-agent-name-input" value={f.agent_name} onChange={(e) => set("agent_name")(e.target.value)} placeholder="e.g. Priya Sharma" /></Field>
          )}
          <Field label="Customer (optional)"><Input data-testid="interaction-customer-input" value={f.customer_name} onChange={(e) => set("customer_name")(e.target.value)} /></Field>
        </div>
        <Tabs value={mode} onValueChange={setMode} className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="audio" data-testid="tab-upload-audio">Upload audio</TabsTrigger>
            <TabsTrigger value="text" data-testid="tab-paste-transcript">Paste transcript</TabsTrigger>
          </TabsList>
          <TabsContent value="audio">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 hover:border-[#1B3F94]/50">
              <input type="file" accept=".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm" className="hidden" data-testid="interaction-audio-input" onChange={(e) => setFile(e.target.files[0] || null)} />
              {file ? <span className="text-slate-900" data-testid="interaction-audio-name">{file.name}</span> : "Click to choose a call recording (mp3, wav, m4a, webm · max 25 MB)"}
            </label>
          </TabsContent>
          <TabsContent value="text">
            <Textarea data-testid="interaction-transcript-input" rows={9} value={f.transcript} onChange={(e) => set("transcript")(e.target.value)}
              placeholder={"Agent: Thank you for calling...\nCustomer: Hi, I was charged twice..."} />
          </TabsContent>
        </Tabs>
        <Button data-testid="interaction-submit-btn" onClick={submit} disabled={busy || (mode === "audio" ? !file : !f.transcript.trim())}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Run AutoQA
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export default function Interactions() {
  const api = useApi();
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  const { isStaff } = useMe();
  const [channel, setChannel] = useState("");
  const load = useCallback(() => api.get("/interactions").then((r) => setItems(r.data)), [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!items?.some((i) => BUSY.includes(i.status))) return;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [items, load]);
  const shown = (items || []).filter((i) => !channel || i.channel === channel);

  return (
    <div>
      <PageHeader eyebrow="Omnichannel AutoQA" title="Interactions" desc="Every call, chat, email, WhatsApp and in-store conversation, scored by AI against your QA forms.">
        {isStaff && <Button variant="outline" className="hover:text-[#1B3F94]" data-testid="bulk-import-btn" onClick={() => setBulk(true)}><Upload className="mr-1.5 h-4 w-4" /> Bulk import</Button>}
        <Button data-testid="new-interaction-btn" onClick={() => setOpen(true)}><Plus className="mr-1.5 h-4 w-4" /> Evaluate interaction</Button>
      </PageHeader>
      <div className="mb-4 flex flex-wrap gap-2">
        {[{ value: "", label: "All" }, ...CHANNELS].map((c) => (
          <button key={c.value} data-testid={`filter-channel-${c.value || "all"}`} onClick={() => setChannel(c.value)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${channel === c.value ? "border-[#1B3F94] bg-[#1B3F94]/15 text-[#1B3F94]" : "border-slate-200 text-slate-500 hover:text-[#1B3F94]"}`}>{c.label}</button>
        ))}
      </div>
      {items === null ? <div className="label-mono">Loading…</div> : shown.length === 0 ? <Empty testId="interactions-empty" text="No interactions yet. Evaluate your first one." /> : (
        <div className="card-surface overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="interactions-table">
            <thead><tr className="label-mono text-left"><th className="p-4">Agent</th><th className="p-4">Channel</th><th className="p-4">Intent</th><th className="p-4">Sentiment</th><th className="p-4">Flags</th><th className="p-4">Date</th><th className="p-4 text-right">Score</th></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id} className="border-t border-slate-200 hover:bg-slate-50" data-testid={`interaction-row-${i.id}`}>
                  <td className="p-4"><Link to={`/interactions/${i.id}`} className="font-medium hover:text-[#1B3F94]">{i.agent_name}</Link><div className="text-xs text-slate-500">{i.customer_name}</div></td>
                  <td className="p-4"><ChannelTag channel={i.channel} /></td>
                  <td className="p-4 text-slate-600">{i.customer_intent || "—"}</td>
                  <td className="p-4 capitalize text-slate-600">{i.sentiment || "—"}</td>
                  <td className="p-4">{i.compliance_flags?.length ? <span className="text-red-600">{i.compliance_flags.length}</span> : <span className="text-slate-600">0</span>}</td>
                  <td className="p-4 text-xs text-slate-500">{fmtDate(i.created_at)}</td>
                  <td className="p-4 text-right" data-testid={`interaction-status-${i.id}`}>
                    {i.dispute?.status === "open" && <Scale className="mr-2 inline h-3.5 w-3.5 text-amber-600" data-testid={`interaction-dispute-icon-${i.id}`} />}
                    {i.status === "scored" ? <ScoreBadge score={i.overall_score} autoFailed={i.auto_failed} />
                      : i.status === "failed" ? <span className="text-xs text-red-600">Failed</span>
                      : <span className="inline-flex items-center gap-1 text-xs text-amber-600"><Loader2 className="h-3 w-3 animate-spin" />{i.status}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewInteractionDialog open={open} onOpenChange={setOpen} onCreated={load} />
      {isStaff && <BulkImportDialog open={bulk} onOpenChange={setBulk} onDone={load} />}
    </div>
  );
}
