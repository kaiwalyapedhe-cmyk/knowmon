import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Users2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { useMe, ROLE_LABELS } from "@/context/MeContext";
import { Empty, Field, NativeSelect, PageHeader, fmtDate } from "@/components/common";

function NewSession({ initialId, onClose }) {
  const api = useApi();
  const nav = useNavigate();
  const { me } = useMe();
  const [items, setItems] = useState([]);
  const [people, setPeople] = useState([]);
  const [f, setF] = useState({ interaction_id: initialId || "", title: "", due: "", participant_ids: [me.user_id] });
  useEffect(() => {
    api.get("/interactions").then((r) => { const s = r.data.filter((i) => i.status === "scored"); setItems(s); setF((p) => ({ ...p, interaction_id: p.interaction_id || s[0]?.id || "" })); });
    api.get("/people").then((r) => setPeople(r.data.filter((p) => p.role !== "agent")));
  }, [api]);
  const toggle = (id) => setF({ ...f, participant_ids: f.participant_ids.includes(id) ? f.participant_ids.filter((x) => x !== id) : [...f.participant_ids, id] });
  const create = async () => {
    try { const r = await api.post("/calibrations", f); toast.success("Calibration session created"); nav(`/calibration/${r.data.id}`); }
    catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="calibration-create-dialog">
        <DialogHeader><DialogTitle>New calibration session</DialogTitle></DialogHeader>
        <Field label="Interaction to calibrate">
          <NativeSelect testId="calibration-interaction-select" value={f.interaction_id} onChange={(v) => setF({ ...f, interaction_id: v })}
            options={items.map((i) => ({ value: i.id, label: `${i.agent_name} · ${i.channel} · ${i.auto_failed ? "FAIL" : i.overall_score} · ${fmtDate(i.created_at)}` }))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title (optional)"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="calibration-title-input" /></Field>
          <Field label="Due"><Input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} data-testid="calibration-due-input" /></Field>
        </div>
        <Field label="Scorers (team leads, QA auditors, admins)">
          <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-md border border-slate-200 p-2">
            {people.map((p) => (
              <label key={p.user_id} className="flex items-center gap-2 text-sm"><Checkbox checked={f.participant_ids.includes(p.user_id)} onCheckedChange={() => toggle(p.user_id)} data-testid={`calibration-participant-${p.user_id}`} />
                {p.name} <span className="text-xs text-slate-400">{ROLE_LABELS[p.role]}</span></label>
            ))}
          </div>
        </Field>
        <Button onClick={create} disabled={!f.interaction_id || !f.participant_ids.length} data-testid="calibration-create-submit-btn">Create session</Button>
      </DialogContent>
    </Dialog>
  );
}

export default function Calibrations() {
  const api = useApi();
  const { isStaff } = useMe();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState(null);
  const [creating, setCreating] = useState(null);
  const load = useCallback(() => api.get("/calibrations").then((r) => setItems(r.data)), [api]);
  useEffect(() => { if (isStaff) load(); }, [load, isStaff]);
  useEffect(() => {
    const from = params.get("from");
    if (from) { setCreating(from); setParams({}, { replace: true }); }
  }, [params, setParams]);
  if (!isStaff) return <p className="text-slate-500">Calibration is for team leads, QA auditors and admins.</p>;
  return (
    <div>
      <PageHeader eyebrow="Scoring standards" title="Calibration" desc="Several reviewers score the same call blind, then compare against each other and the AI to agree one standard.">
        <Button onClick={() => setCreating("")} data-testid="calibration-new-btn"><Plus className="mr-1 h-4 w-4" />New session</Button>
      </PageHeader>
      {items === null ? <div className="label-mono">Loading…</div> : items.length === 0 ? <Empty testId="calibration-empty" text="No calibration sessions yet. Start one from any scored interaction." /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((c) => (
            <Link key={c.id} to={`/calibration/${c.id}`} className="card-surface card-hover block p-6" data-testid={`calibration-card-${c.id}`}>
              <div className="flex items-center justify-between">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.status === "open" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>{c.status === "open" ? "Open" : "Agreed"}</span>
                <span className="font-mono text-xs text-slate-400">{c.submitted_count}/{c.participant_ids.length} scored</span>
              </div>
              <h3 className="mt-3 text-lg font-semibold">{c.title}</h3>
              <div className="mt-1 flex items-center gap-2 text-xs text-slate-500"><Users2 className="h-3.5 w-3.5" />{c.participant_names.join(", ")}</div>
              <div className="mt-3 text-sm text-slate-600">AI {c.ai_overall}{c.final && <> · agreed <span className="font-semibold text-[#1B3F94]">{c.final.overall}</span></>}{c.due && <span className="text-slate-400"> · due {c.due}</span>}</div>
              {!c.submitted && c.status === "open" && <div className="mt-2 text-xs font-semibold text-[#E31E24]">Your score is needed</div>}
            </Link>
          ))}
        </div>
      )}
      {creating !== null && <NewSession initialId={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}
