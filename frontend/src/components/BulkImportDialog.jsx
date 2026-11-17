import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, errMsg } from "@/lib/api";
import { CHANNELS, Field, NativeSelect } from "@/components/common";

const TEMPLATE = 'agent_name,agent_email,channel,customer_name,form,transcript\nPriya Sharma,,chat,Ravi,"Chat, Email & WhatsApp QA","Agent: Hello, how can I help?\nCustomer: I need a refund."\n';

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "cadence-bulk-import-template.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

export function BulkImportDialog({ open, onOpenChange, onDone }) {
  const api = useApi();
  const [forms, setForms] = useState([]);
  const [people, setPeople] = useState([]);
  const [mode, setMode] = useState("sheet");
  const [sheet, setSheet] = useState(null);
  const [files, setFiles] = useState([]);
  const [f, setF] = useState({ channel: "voice", form_id: "", agent_id: "", agent_name: "" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!open) return;
    setResult(null); setSheet(null); setFiles([]);
    api.get("/qa-forms").then((r) => { setForms(r.data); setF((p) => ({ ...p, form_id: p.form_id || r.data[0]?.id || "" })); });
    api.get("/people").then((r) => setPeople(r.data));
  }, [open, api]);

  const submit = async () => {
    const fd = new FormData();
    if (mode === "sheet") { fd.append("file", sheet); fd.append("form_id", f.form_id); }
    else { files.forEach((x) => fd.append("files", x)); Object.entries(f).forEach(([k, v]) => fd.append(k, v)); }
    setBusy(true);
    try {
      const r = await api.post(mode === "sheet" ? "/interactions/bulk-sheet" : "/interactions/bulk-audio", fd);
      setResult(r.data);
      toast.success(`${r.data.created} interaction(s) queued for AutoQA`);
      onDone();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const ready = mode === "sheet" ? !!sheet : files.length > 0 && (f.agent_id || f.agent_name.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="bulk-import-dialog">
        <DialogHeader><DialogTitle>Bulk import & score</DialogTitle></DialogHeader>
        <Tabs value={mode} onValueChange={setMode}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="sheet" data-testid="bulk-tab-sheet">Spreadsheet</TabsTrigger>
            <TabsTrigger value="audio" data-testid="bulk-tab-audio">Recordings</TabsTrigger>
          </TabsList>
          <TabsContent value="sheet" className="space-y-4">
            <p className="text-sm text-slate-500">One row per interaction (CSV or Excel, up to 200 rows). Columns: agent_name, agent_email (links the agent's account), channel, customer_name, form, transcript.</p>
            <Button variant="outline" size="sm" className="hover:text-[#1B3F94]" onClick={downloadTemplate} data-testid="bulk-template-btn"><Download className="mr-1 h-3 w-3" />Download template</Button>
            <Field label="Default QA form (when a row has none)"><NativeSelect testId="bulk-sheet-form-select" value={f.form_id} onChange={(v) => setF({ ...f, form_id: v })} options={forms.map((x) => ({ value: x.id, label: x.name }))} /></Field>
            <Input type="file" accept=".csv,.xlsx" onChange={(e) => setSheet(e.target.files[0] || null)} data-testid="bulk-sheet-input" />
          </TabsContent>
          <TabsContent value="audio" className="space-y-4">
            <p className="text-sm text-slate-500">Select up to 50 call recordings for one agent. Each is transcribed, stored for playback and scored.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Channel"><NativeSelect testId="bulk-audio-channel-select" value={f.channel} onChange={(v) => setF({ ...f, channel: v })} options={CHANNELS} /></Field>
              <Field label="QA form"><NativeSelect testId="bulk-audio-form-select" value={f.form_id} onChange={(v) => setF({ ...f, form_id: v })} options={forms.map((x) => ({ value: x.id, label: x.name }))} /></Field>
              <Field label="Agent"><NativeSelect testId="bulk-audio-agent-select" value={f.agent_id} onChange={(v) => setF({ ...f, agent_id: v })} options={[{ value: "", label: "Type a name…" }, ...people.map((p) => ({ value: p.user_id, label: p.name }))]} /></Field>
              {!f.agent_id && <Field label="Agent name"><Input value={f.agent_name} onChange={(e) => setF({ ...f, agent_name: e.target.value })} data-testid="bulk-audio-agent-name-input" /></Field>}
            </div>
            <Input type="file" multiple accept=".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm" onChange={(e) => setFiles([...e.target.files])} data-testid="bulk-audio-input" />
            {files.length > 0 && <p className="text-xs text-slate-500" data-testid="bulk-audio-count">{files.length} file(s) selected</p>}
          </TabsContent>
        </Tabs>
        {result && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="bulk-result">
            <div className="font-semibold text-emerald-600">{result.created} queued for scoring</div>
            {result.errors.map((e, i) => <div key={i} className="text-red-600">Row {e.row}: {e.error}</div>)}
          </div>
        )}
        <Button onClick={submit} disabled={busy || !ready} data-testid="bulk-submit-btn">{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Import and score</Button>
      </DialogContent>
    </Dialog>
  );
}
