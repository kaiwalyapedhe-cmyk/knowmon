import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, Pencil, History, RotateCcw, Search, ExternalLink, ShieldAlert, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Field, NativeSelect, PageHeader, ChannelTag } from "@/components/common";

const blankCrit = () => ({ name: "", description: "", weight: 1, type: "scale", auto_fail: false });
const CH = [
  { value: "all", label: "All channels" },
  { value: "voice", label: "Voice" },
  { value: "chat", label: "Chat / Email / WhatsApp" },
  { value: "in_store", label: "In-store" },
];

function CriterionRow({ c, i, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...c, [k]: v });
  return (
    <div className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-12 shadow-xs items-center" data-testid={`criterion-row-${i}`}>
      <Input
        className="sm:col-span-3 bg-white border-slate-200 h-9 text-xs focus:ring-2 focus:ring-[#1B3F94]"
        placeholder="Criterion name"
        value={c.name}
        onChange={(e) => set("name", e.target.value)}
        data-testid={`criterion-name-${i}`}
      />
      <Input
        className="sm:col-span-4 bg-white border-slate-200 h-9 text-xs focus:ring-2 focus:ring-[#1B3F94]"
        placeholder="Rubric benchmark / description"
        value={c.description}
        onChange={(e) => set("description", e.target.value)}
        data-testid={`criterion-desc-${i}`}
      />
      <Input
        className="sm:col-span-1 bg-white border-slate-200 h-9 text-xs text-center font-mono focus:ring-2 focus:ring-[#1B3F94]"
        type="number"
        min="0.5"
        step="0.5"
        value={c.weight}
        onChange={(e) => set("weight", Number(e.target.value))}
        data-testid={`criterion-weight-${i}`}
      />
      <NativeSelect
        className="sm:col-span-2 bg-white border-slate-200 h-9 text-xs"
        value={c.type}
        onChange={(v) => set("type", v)}
        testId={`criterion-type-${i}`}
        options={[{ value: "scale", label: "Scale 0-100" }, { value: "binary", label: "Pass / Fail" }]}
      />
      <label className="flex items-center gap-1.5 text-[11px] font-semibold text-red-700 sm:col-span-1 cursor-pointer">
        <Switch
          checked={c.auto_fail}
          onCheckedChange={(v) => set("auto_fail", v)}
          data-testid={`criterion-autofail-${i}`}
          className="scale-90"
        />
        Fail
      </label>
      <div className="sm:col-span-1 flex justify-end">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-slate-400 hover:text-red-600"
          onClick={onRemove}
          data-testid={`criterion-remove-${i}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function VersionHistory({ form, onClose, onRestored }) {
  const api = useApi();
  const [versions, setVersions] = useState(null);
  useEffect(() => {
    api.get(`/qa-forms/${form.id}/versions`)
      .then((r) => setVersions(r.data))
      .catch((e) => toast.error(errMsg(e)));
  }, [api, form.id]);

  const restore = async (v) => {
    if (!window.confirm(`Restore version ${v.version}? The current rubric stays in history.`)) return;
    try {
      await api.post(`/qa-forms/${form.id}/versions/${v.id}/restore`);
      toast.success(`Restored version ${v.version}`);
      onRestored();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="qa-form-history">
        <DialogHeader className="border-b border-slate-200 pb-3">
          <div className="label-mono">Audit Rubric History</div>
          <DialogTitle className="text-lg font-bold text-[#16357F] mt-1">
            {form.name} ({form.form_id || form.id})
          </DialogTitle>
        </DialogHeader>
        {versions === null ? (
          <div className="label-mono py-6 text-center">Loading history…</div>
        ) : versions.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No previous versions recorded yet.</p>
        ) : (
          <ul className="space-y-2.5 text-sm pt-2">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3.5 shadow-xs">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-[#1B3F94] bg-[#1B3F94]/10 px-2 py-0.5 rounded">
                      v{v.version}
                    </span>
                    <span className="font-semibold text-slate-900">{v.name}</span>
                    <span className="font-mono text-[11px] text-slate-400">({v.criteria.length} criteria)</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {v.change_note || "Version update"} · by <span className="font-medium text-slate-700">{v.created_by_name || "System"}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-slate-200 hover:text-[#1B3F94] hover:bg-[#1B3F94]/5 h-8 text-xs font-medium"
                  onClick={() => restore(v)}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5 text-[#1B3F94]" /> Restore
                </Button>
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
  const [f, setF] = useState({
    name: "",
    form_id: "",
    process_name: "",
    description: "",
    channel: "all",
    criteria: [blankCrit()],
    ...form,
  });

  const save = async () => {
    try {
      const payload = {
        name: f.name,
        form_id: f.form_id || f.id,
        process_name: f.process_name || f.name,
        description: f.description,
        channel: f.channel,
        criteria: f.criteria,
      };
      if (f.id) {
        await api.put(`/qa-forms/${f.id}`, payload);
      } else {
        await api.post("/qa-forms", payload);
      }
      toast.success("QA form saved successfully");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const setCrit = (i, c) => setF({ ...f, criteria: f.criteria.map((x, j) => (j === i ? c : x)) });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" data-testid="qa-form-editor">
        <DialogHeader className="border-b border-slate-200 pb-3">
          <div className="label-mono">Rubric Configuration</div>
          <DialogTitle className="text-xl font-bold text-[#16357F] mt-1">
            {f.id ? `Edit QA Form · ${f.name}` : "Create New QA Form"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-3 pt-2">
          <Field label="Form Name">
            <Input
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="e.g. SM FORM"
              className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              data-testid="qa-form-name-input"
            />
          </Field>
          <Field label="Form ID / Code">
            <Input
              value={f.form_id || f.id || ""}
              onChange={(e) => setF({ ...f, form_id: e.target.value })}
              placeholder="e.g. PID0053_001"
              className="bg-white border-slate-200 font-mono focus:ring-2 focus:ring-[#1B3F94]"
            />
          </Field>
          <Field label="Channel">
            <NativeSelect
              value={f.channel}
              onChange={(v) => setF({ ...f, channel: v })}
              options={CH}
              className="bg-white border-slate-200"
              testId="qa-form-channel-select"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input
                value={f.description}
                onChange={(e) => setF({ ...f, description: e.target.value })}
                placeholder="Brief description of when this QA form rubric is applied"
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
                data-testid="qa-form-desc-input"
              />
            </Field>
          </div>
          <div>
            <Field label="Process Name">
              <Input
                value={f.process_name || ""}
                onChange={(e) => setF({ ...f, process_name: e.target.value })}
                placeholder="e.g. SM FORM"
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </Field>
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between mb-3">
            <div className="label-mono">Rubric Criteria & Weightings</div>
            <span className="text-xs text-slate-500 font-mono">{f.criteria?.length || 0} criteria defined</span>
          </div>

          <div className="space-y-2.5 max-h-72 overflow-y-auto p-1">
            {(f.criteria || []).map((c, i) => (
              <CriterionRow
                key={i}
                c={c}
                i={i}
                onChange={(v) => setCrit(i, v)}
                onRemove={() => setF({ ...f, criteria: f.criteria.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-slate-200">
          <Button
            variant="outline"
            onClick={() => setF({ ...f, criteria: [...f.criteria, blankCrit()] })}
            data-testid="add-criterion-btn"
            className="border-slate-200 text-slate-700 hover:text-[#1B3F94] hover:bg-[#1B3F94]/5 font-medium"
          >
            <Plus className="mr-1.5 h-4 w-4 text-[#1B3F94]" /> Add Criterion
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              data-testid="qa-form-save-btn"
              disabled={!f.name || !f.criteria?.length || f.criteria.some((c) => !c.name)}
              className="bg-[#1B3F94] hover:bg-[#153275] text-white font-medium px-6 shadow-sm"
            >
              Save QA Form
            </Button>
          </div>
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
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("");

  const load = useCallback(() => {
    api.get("/qa-forms").then((r) => setForms(r.data)).catch(() => {});
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const remove = async (id) => {
    if (!window.confirm("Are you sure you want to delete this QA form?")) return;
    try {
      await api.delete(`/qa-forms/${id}`);
      toast.success("QA form deleted");
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const filteredForms = forms.filter((f) => {
    const term = search.toLowerCase().trim();
    const matchTerm =
      !term ||
      f.name?.toLowerCase().includes(term) ||
      f.id?.toLowerCase().includes(term) ||
      f.form_id?.toLowerCase().includes(term) ||
      f.description?.toLowerCase().includes(term) ||
      f.process_name?.toLowerCase().includes(term);

    const matchChannel = !channelFilter || f.channel === channelFilter;
    return matchTerm && matchChannel;
  });

  if (!isQA) return <p className="text-slate-500 p-8">Only admins and QA auditors can manage QA forms.</p>;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Quality Rubrics & Monitoring"
        title="QA Forms"
        desc="Define and manage evaluation rubrics used to score interactions and CadenceCX audits. Configure weighted criteria, pass/fail thresholds, and zero-tolerance compliance triggers."
      >
        <Button
          data-testid="new-qa-form-btn"
          onClick={() => setEditing({ name: "", form_id: "", process_name: "", description: "", channel: "all", criteria: [blankCrit()] })}
          className="bg-[#1B3F94] hover:bg-[#153275] text-white font-medium shadow-sm"
        >
          <Plus className="mr-1.5 h-4 w-4" /> New Form
        </Button>
      </PageHeader>

      {/* Filter and Search Bar */}
      <div className="card-surface p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <Search className="h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search forms by name, Form ID (e.g. PID0053_001), or keyword..."
            className="bg-white border-slate-200 h-9 text-xs focus:ring-2 focus:ring-[#1B3F94]"
          />
        </div>

        <div className="flex items-center gap-2">
          {[{ value: "", label: "All Channels" }, ...CH].map((c) => (
            <button
              key={c.value}
              onClick={() => setChannelFilter(c.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                channelFilter === c.value
                  ? "border-[#1B3F94] bg-[#1B3F94]/10 text-[#1B3F94]"
                  : "border-slate-200 text-slate-600 hover:text-[#1B3F94] hover:border-[#1B3F94]/40"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Forms Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {filteredForms.map((f) => {
          const isTransmonSM = f.id === "PID0053_001" || f.name === "SM FORM";

          return (
            <div
              key={f.id}
              className="card-surface card-hover p-6 rounded-xl border border-slate-200 bg-white flex flex-col justify-between"
              data-testid={`qa-form-card-${f.id}`}
            >
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-bold text-[#16357F]">{f.name}</h3>
                      <span className="font-mono text-xs font-semibold bg-[#1B3F94]/10 text-[#1B3F94] px-2 py-0.5 rounded border border-[#1B3F94]/20">
                        {f.form_id || f.id}
                      </span>
                      {isTransmonSM && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                          CadenceCX / SM FORM
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-slate-500 line-clamp-2">{f.description}</p>
                    <div className="label-mono mt-2 flex items-center gap-3">
                      <span>v{f.version || 1}</span>
                      <span>·</span>
                      <span>{f.criteria?.length || 0} criteria</span>
                      <span>·</span>
                      <span className="capitalize">{f.channel === "all" ? "All channels" : f.channel}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-slate-500 hover:text-[#1B3F94]"
                      title="Rubric version history"
                      onClick={() => setHistory(f)}
                      data-testid={`history-qa-form-${f.id}`}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-slate-500 hover:text-[#1B3F94]"
                      title="Edit rubric"
                      onClick={() => setEditing(f)}
                      data-testid={`edit-qa-form-${f.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-slate-400 hover:text-red-600"
                      title="Delete form"
                      onClick={() => remove(f.id)}
                      data-testid={`delete-qa-form-${f.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Criteria Rubric List */}
                <div className="mt-5 space-y-2 border-t border-slate-100 pt-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                    Scoring Rubric Items:
                  </div>
                  {f.criteria.map((c, idx) => (
                    <div
                      key={c.id || idx}
                      className="flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-slate-50 border-b border-slate-50 last:border-0"
                    >
                      <div className="flex items-center gap-2 flex-1 mr-2">
                        <span className="font-medium text-slate-800">{c.name}</span>
                        {c.auto_fail && (
                          <span className="rounded bg-red-50 text-red-600 border border-red-200 px-1.5 py-0.2 font-mono text-[9px] font-bold">
                            AUTO-FAIL
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-slate-500 font-mono text-[11px]">
                        <span className="capitalize">{c.type}</span>
                        <span className="text-slate-700 font-semibold">×{c.weight}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Card Footer */}
              <div className="mt-6 pt-3 border-t border-slate-100 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">
                  Total Weight: <strong>{f.criteria.reduce((acc, c) => acc + (c.weight || 1), 0).toFixed(1)}</strong>
                </span>
                <Link
                  to="/qa-operations"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#1B3F94] hover:underline"
                >
                  View Audits in QA Operations <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {editing && <FormEditor form={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {history && <VersionHistory form={history} onClose={() => setHistory(null)} onRestored={load} />}
    </div>
  );
}
