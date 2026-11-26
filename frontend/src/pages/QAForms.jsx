import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Pencil, History, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Field, NativeSelect, PageHeader } from "@/components/common";

const blankCrit = () => ({ name: "", description: "", weight: 1, type: "scale", auto_fail: false });
const CH = [{ value: "all", label: "All channels" }, { value: "voice", label: "Voice" }, { value: "chat", label: "Chat / Email / WhatsApp" }, { value: "in_store", label: "In-store" }];

function CriterionRow({ c, i, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...c, [k]: v });
  return (
    <div className="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-12" data-testid={`criterion-row-${i}`}>
      <Input className="sm:col-span-3" placeholder="Criterion" value={c.name} onChange={(e) => set("name", e.target.value)} data-testid={`criterion-name-${i}`} />
      <Input className="sm:col-span-4" placeholder="What good looks like" value={c.description} onChange={(e) => set("description", e.target.value)} data-testid={`criterion-desc-${i}`} />
      <Input className="sm:col-span-1" type="number" min="0.5" step="0.5" value={c.weight} onChange={(e) => set("weight", Number(e.target.value))} data-testid={`criterion-weight-${i}`} />
      <NativeSelect className="sm:col-span-2" value={c.type} onChange={(v) => set("type", v)} testId={`criterion-type-${i}`} options={[{ value: "scale", label: "Scale 0-100" }, { value: "binary", label: "Pass / Fail" }]} />
      <label className="flex items-center gap-2 text-xs text-red-700 sm:col-span-1"><Switch checked={c.auto_fail} onCheckedChange={(v) => set("auto_fail", v)} data-testid={`criterion-autofail-${i}`} />Fail</label>
      <Button variant="ghost" size="icon" className="sm:col-span-1 hover:text-[#1B3F94]" onClick={onRemove} data-testid={`criterion-remove-${i}`}><Trash2 className="h-4 w-4" /></Button>
    </div>
  );
}

function VersionHistory({ form, onClose, onRestored }) {
  const api = useApi();
  const [versions, setVersions] = useState(null);
  useEffect(() => { api.get(`/qa-forms/${form.id}/versions`).then((r) => setVersions(r.data)).catch((e) => toast.error(errMsg(e))); }, [api, form.id]);
  const restore = async (v) => {
    if (!window.confirm(`Restore version ${v.version}? The current rubric stays in history.`)) return;
    try { await api.post(`/qa-forms/${form.id}/versions/${v.id}/restore`); toast.success(`Restored version ${v.version}`); onRestored(); onClose(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="qa-form-history">
        <DialogHeader><DialogTitle>{form.name} · rubric history</DialogTitle></DialogHeader>
        {versions === null ? <div className="label-mono">Loading…</div> : versions.length === 0 ? <p className="text-sm text-slate-500">No versions recorded yet.</p> : (
          <ul className="space-y-2 text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 p-3">
                <div>
                  <div><span className="font-mono text-xs font-semibold text-[#1B3F94]">v{v.version}</span> · {v.name} <span className="font-mono text-[10px] text-slate-400">{v.criteria.length} criteria</span></div>
                  <div className="text-xs text-slate-500">{v.change_note || "No note"} · {v.created_by_name || "—"}</div>
                </div>
                <Button size="sm" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => restore(v)}><RotateCcw className="mr-1 h-3.5 w-3.5" />Restore</Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FormEditor({ form, onClose, onSaved }) {
  const api = useApi();
  const [f, setF] = useState(form);
  const save = async () => {
    try {
      if (f.id) await api.put(`/qa-forms/${f.id}`, f); else await api.post("/qa-forms", f);
      toast.success("QA form saved"); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); }
  };
  const setCrit = (i, c) => setF({ ...f, criteria: f.criteria.map((x, j) => (j === i ? c : x)) });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" data-testid="qa-form-editor">
        <DialogHeader><DialogTitle>{f.id ? "Edit QA form" : "New QA form"}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="qa-form-name-input" /></Field>
          <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} data-testid="qa-form-desc-input" /></Field>
          <Field label="Channel"><NativeSelect value={f.channel} onChange={(v) => setF({ ...f, channel: v })} options={CH} testId="qa-form-channel-select" /></Field>
        </div>
        <div className="label-mono mt-2">Criteria · weight · type · auto-fail</div>
        <div className="space-y-2">{f.criteria.map((c, i) => <CriterionRow key={i} c={c} i={i} onChange={(v) => setCrit(i, v)} onRemove={() => setF({ ...f, criteria: f.criteria.filter((_, j) => j !== i) })} />)}</div>
        <div className="flex justify-between">
          <Button variant="outline" onClick={() => setF({ ...f, criteria: [...f.criteria, blankCrit()] })} data-testid="add-criterion-btn" className="hover:text-[#1B3F94]"><Plus className="mr-1 h-4 w-4" />Add criterion</Button>
          <Button onClick={save} data-testid="qa-form-save-btn" disabled={!f.name || !f.criteria.length || f.criteria.some((c) => !c.name)}>Save form</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function QAForms() {
  const api = useApi();
  const { isQA } = useMe();
  const [forms, setForms] = useState([]);
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState(null);
  const load = useCallback(() => api.get("/qa-forms").then((r) => setForms(r.data)), [api]);
  useEffect(() => { load(); }, [load]);
  const remove = async (id) => { if (!window.confirm("Delete this QA form?")) return; await api.delete(`/qa-forms/${id}`); load(); };
  if (!isQA) return <p className="text-slate-500">Only admins and QA auditors manage QA forms.</p>;
  return (
    <div>
      <PageHeader eyebrow="Quality monitoring forms" title="QA Forms" desc="Rubrics the AI uses to score every interaction. Weighted criteria, pass/fail checks and auto-fail compliance triggers.">
        <Button data-testid="new-qa-form-btn" onClick={() => setEditing({ name: "", description: "", channel: "all", criteria: [blankCrit()] })}><Plus className="mr-1 h-4 w-4" />New form</Button>
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-2">
        {forms.map((f) => (
          <div key={f.id} className="card-surface card-hover p-6" data-testid={`qa-form-card-${f.id}`}>
            <div className="flex items-start justify-between gap-4">
              <div><h3 className="text-lg font-semibold">{f.name}</h3><p className="text-sm text-slate-500">{f.description}</p><div className="label-mono mt-1">v{f.version || 1} · {f.criteria.length} criteria</div></div>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" title="Rubric history" onClick={() => setHistory(f)} data-testid={`history-qa-form-${f.id}`}><History className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => setEditing(f)} data-testid={`edit-qa-form-${f.id}`}><Pencil className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => remove(f.id)} data-testid={`delete-qa-form-${f.id}`}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
            <ul className="mt-4 space-y-1.5 text-sm">
              {f.criteria.map((c) => (
                <li key={c.id} className="flex justify-between border-t border-slate-200 pt-1.5"><span>{c.name}{c.auto_fail && <span className="ml-2 font-mono text-[10px] text-red-700">AUTO-FAIL</span>}</span><span className="font-mono text-xs text-slate-500">{c.type} · ×{c.weight}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {editing && <FormEditor form={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {history && <VersionHistory form={history} onClose={() => setHistory(null)} onRestored={load} />}
    </div>
  );
}
