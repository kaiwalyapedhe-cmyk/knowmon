import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Play, Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Empty, Field, NativeSelect, PageHeader, fmtDate } from "@/components/common";
import TransmonAuditReport from "@/components/TransmonAuditReport";
import TransmonAutoSampling from "@/components/TransmonAutoSampling";

const PERIODS = [{ value: "monthly", label: "This month" }, { value: "weekly", label: "Last 7 days" }, { value: "daily", label: "Last 24 hours" }];
const CHANNELS = [{ value: "all", label: "All channels" }, { value: "voice", label: "Voice" }, { value: "chat", label: "Chat" }, { value: "email", label: "Email" }, { value: "whatsapp", label: "WhatsApp" }, { value: "in_store", label: "In-store" }];
const POLICY_PERIODS = [{ value: "monthly", label: "Monthly" }, { value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }];
const STATUS_STYLE = { pending: "bg-amber-100 text-amber-700", in_progress: "bg-[#1B3F94]/10 text-[#1B3F94]", completed: "bg-emerald-100 text-emerald-700", cancelled: "bg-slate-100 text-slate-500" };
const SLA_STYLE = { met: "text-emerald-600", on_track: "text-emerald-600", due_soon: "text-amber-600", overdue: "text-red-600", missed: "text-red-600", unscheduled: "text-slate-400", "n/a": "text-slate-400" };
const SLA_LABEL = { met: "SLA met", on_track: "On track", due_soon: "Due soon", overdue: "Overdue", missed: "SLA missed", unscheduled: "No due date", "n/a": "—" };

const blankPolicy = { name: "", channel: "all", period: "monthly", target_per_agent: 4, sample_percent: 20, sla_days: 3, include_flagged: true, include_auto_fail: true, active: true };

function Kpi({ label, value, note }) {
  return (
    <div className="card-surface p-5">
      <div className="label-mono">{label}</div>
      <div className="mt-2 text-3xl font-extrabold tracking-tight">{value}</div>
      {note && <div className="mt-1 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

function PolicyDialog({ policy, onClose, onSaved }) {
  const api = useApi();
  const [f, setF] = useState(policy);
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    try {
      if (f.id) await api.put(`/qa-ops/policies/${f.id}`, f); else await api.post("/qa-ops/policies", f);
      toast.success("Sampling policy saved"); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{f.id ? "Edit sampling policy" : "New sampling policy"}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Policy name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} data-testid="policy-name-input" /></Field>
          <Field label="Channel"><NativeSelect value={f.channel} onChange={(v) => set("channel", v)} options={CHANNELS} testId="policy-channel-select" /></Field>
          <Field label="Period"><NativeSelect value={f.period} onChange={(v) => set("period", v)} options={POLICY_PERIODS} testId="policy-period-select" /></Field>
          <Field label="Target evaluations per agent"><Input type="number" min="0" max="200" value={f.target_per_agent} onChange={(e) => set("target_per_agent", Number(e.target.value))} data-testid="policy-target-input" /></Field>
          <Field label="Random sample of eligible calls (%)"><Input type="number" min="0" max="100" value={f.sample_percent} onChange={(e) => set("sample_percent", Number(e.target.value))} data-testid="policy-percent-input" /></Field>
          <Field label="Review SLA (days)"><Input type="number" min="1" max="60" value={f.sla_days} onChange={(e) => set("sla_days", Number(e.target.value))} data-testid="policy-sla-input" /></Field>
        </div>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2"><Switch checked={f.include_flagged} onCheckedChange={(v) => set("include_flagged", v)} />Always sample flagged calls</label>
          <label className="flex items-center gap-2"><Switch checked={f.include_auto_fail} onCheckedChange={(v) => set("include_auto_fail", v)} />Always sample auto-fails</label>
          <label className="flex items-center gap-2"><Switch checked={f.active} onCheckedChange={(v) => set("active", v)} />Active</label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!f.name} data-testid="policy-save-btn">Save policy</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function QAOperations() {
  const api = useApi();
  const { isQA } = useMe();
  const [period, setPeriod] = useState("monthly");
  const [overview, setOverview] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    api.get("/qa-ops/overview", { params: { period } }).then((r) => setOverview(r.data)).catch((e) => toast.error(errMsg(e)));
    api.get("/qa-ops/assignments", { params: filter ? { status: filter } : {} }).then((r) => setAssignments(r.data)).catch(() => {});
    api.get("/qa-ops/policies").then((r) => setPolicies(r.data)).catch(() => {});
  }, [api, period, filter]);
  useEffect(() => { load(); }, [load]);

  const sample = async (id) => {
    try {
      const r = await api.post("/qa-ops/sample", { policy_id: id });
      toast.success(`Assigned ${r.data.created} of ${r.data.considered} eligible interactions`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const updateTask = async (a, status, outcome = "") => {
    try {
      await api.patch(`/qa-ops/assignments/${a.id}`, { status, outcome });
      toast.success(status === "completed" ? "Review completed" : "Task updated");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const removePolicy = async (id) => {
    if (!window.confirm("Delete this sampling policy?")) return;
    await api.delete(`/qa-ops/policies/${id}`); load();
  };

  const active = overview?.policy;
  return (
    <div>
      <PageHeader eyebrow="QA operations" title="QA Operations & Audit Reports" desc="Run full Transmon audit reports, configure auto-sampling batches, manage coverage, and review evaluator queue.">
        {isQA && active && <Button onClick={() => sample(active.id)} data-testid="run-sampling-btn" className="bg-[#1B3F94] hover:bg-[#153275] text-white"><Play className="mr-1 h-4 w-4" />Run “{active.name}”</Button>}
      </PageHeader>

      <Tabs defaultValue="audit-report">
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:grid-cols-5">
          <TabsTrigger value="audit-report">Audit Report</TabsTrigger>
          <TabsTrigger value="auto-sampling">Auto Sampling</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>

        <TabsContent value="audit-report" className="mt-6">
          <TransmonAuditReport />
        </TabsContent>

        <TabsContent value="auto-sampling" className="mt-6">
          <TransmonAutoSampling />
        </TabsContent>

        <TabsContent value="coverage" className="mt-6 space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-40"><NativeSelect value={period} onChange={setPeriod} options={PERIODS} testId="coverage-period-select" /></div>
            {overview && <span className="text-xs text-slate-500">{overview.kpis.evaluated} scored interactions · target {overview.target_per_agent}/agent</span>}
          </div>
          {!overview ? <div className="label-mono">Loading…</div> : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Kpi label="QA coverage" value={`${overview.kpis.coverage}%`} note={`${overview.kpis.assigned} of ${overview.kpis.evaluated} interactions`} />
                <Kpi label="Open reviews" value={overview.kpis.pending} note="Pending or in progress" />
                <Kpi label="Overdue" value={overview.kpis.overdue} note="Past the review SLA" />
                <Kpi label="SLA met" value={`${overview.kpis.sla_met}%`} note={`${overview.kpis.completed} completed`} />
                <Kpi label="Completed" value={overview.kpis.completed} note={`${overview.statuses.in_progress} in progress`} />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="card-surface p-6">
                  <div className="label-mono mb-4">Coverage by agent</div>
                  {overview.by_agent.length === 0 ? <Empty text="No agents yet." /> : (
                    <table className="w-full text-sm">
                      <thead><tr className="label-mono text-left"><th className="pb-2">Agent</th><th className="pb-2 text-right">Assigned</th><th className="pb-2 text-right">Done</th><th className="pb-2 text-right">Target</th><th className="pb-2 text-right">Coverage</th></tr></thead>
                      <tbody>
                        {overview.by_agent.map((a) => (
                          <tr key={a.agent_id || a.agent_name} className="border-t border-slate-200">
                            <td className="py-2">{a.agent_name}</td>
                            <td className="py-2 text-right font-mono text-xs">{a.assigned}</td>
                            <td className="py-2 text-right font-mono text-xs">{a.completed}</td>
                            <td className="py-2 text-right font-mono text-xs">{a.target || "—"}</td>
                            <td className={`py-2 text-right font-mono text-xs ${a.target && a.coverage < 100 ? "text-amber-600" : "text-emerald-600"}`}>{a.target ? `${a.coverage}%` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="card-surface p-6">
                  <div className="label-mono mb-4">Evaluator workload</div>
                  {overview.workload.length === 0 ? <Empty text="No reviews assigned yet." /> : (
                    <table className="w-full text-sm">
                      <thead><tr className="label-mono text-left"><th className="pb-2">Evaluator</th><th className="pb-2 text-right">Open</th><th className="pb-2 text-right">Done</th><th className="pb-2 text-right">Overdue</th></tr></thead>
                      <tbody>
                        {overview.workload.map((w) => (
                          <tr key={w.evaluator_id} className="border-t border-slate-200">
                            <td className="py-2">{w.name || "—"}</td>
                            <td className="py-2 text-right font-mono text-xs">{w.open}</td>
                            <td className="py-2 text-right font-mono text-xs">{w.completed}</td>
                            <td className={`py-2 text-right font-mono text-xs ${w.overdue ? "text-red-600" : "text-slate-400"}`}>{w.overdue}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="queue" className="mt-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="w-40"><NativeSelect value={filter} onChange={setFilter} options={[{ value: "", label: "All statuses" }, { value: "pending", label: "Pending" }, { value: "in_progress", label: "In progress" }, { value: "completed", label: "Completed" }]} testId="queue-filter-select" /></div>
            <span className="text-xs text-slate-500">{assignments.length} tasks</span>
          </div>
          {assignments.length === 0 ? <Empty testId="queue-empty" text="No review tasks yet. Run a sampling policy to fill the queue." /> : (
            <div className="card-surface overflow-x-auto p-2">
              <table className="w-full min-w-[760px] text-sm">
                <thead><tr className="label-mono text-left"><th className="p-3">Interaction</th><th className="p-3">Agent</th><th className="p-3">Evaluator</th><th className="p-3">Source</th><th className="p-3">Due</th><th className="p-3">SLA</th><th className="p-3">Status</th><th className="p-3" /></tr></thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.id} className="border-t border-slate-200" data-testid={`assignment-${a.id}`}>
                      <td className="p-3"><Link to={`/interactions/${a.interaction_id}`} className="text-[#1B3F94] hover:underline">{a.form_name || a.channel}</Link><div className="font-mono text-[10px] text-slate-400">{a.score_at_assignment != null ? `${a.score_at_assignment}% scored` : ""}</div></td>
                      <td className="p-3">{a.agent_name || "—"}</td>
                      <td className="p-3">{a.evaluator_name || "—"}</td>
                      <td className="p-3"><span className="font-mono text-[10px] uppercase text-slate-500">{a.source}</span></td>
                      <td className="p-3 text-xs text-slate-500">{fmtDate(a.due_at)}</td>
                      <td className={`p-3 text-xs font-semibold ${SLA_STYLE[a.sla] || ""}`}>{SLA_LABEL[a.sla] || a.sla}</td>
                      <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[a.status]}`}>{a.status.replace("_", " ")}</span></td>
                      <td className="p-3 text-right">
                        {a.status === "pending" && <Button size="sm" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => updateTask(a, "in_progress")}>Start</Button>}
                        {a.status !== "completed" && a.status !== "cancelled" && <Button size="sm" className="ml-1" onClick={() => updateTask(a, "completed", "confirmed")} data-testid={`complete-${a.id}`}>Complete</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="policies" className="mt-6 space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setEditing({ ...blankPolicy })} data-testid="new-policy-btn"><Plus className="mr-1 h-4 w-4" />New policy</Button>
          </div>
          {policies.length === 0 ? <Empty text="No sampling policies yet." /> : (
            <div className="grid gap-4 md:grid-cols-2">
              {policies.map((p) => (
                <div key={p.id} className="card-surface p-5" data-testid={`policy-card-${p.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold">{p.name}</h3>
                      <div className="label-mono mt-1">{p.period} · {p.channel === "all" ? "all channels" : p.channel} · SLA {p.sla_days}d</div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => sample(p.id)} title="Run sampling"><Play className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" className="hover:text-[#E31E24]" onClick={() => removePolicy(p.id)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded bg-slate-50 py-2"><div className="font-mono text-lg font-bold text-[#1B3F94]">{p.target_per_agent}</div>per agent</div>
                    <div className="rounded bg-slate-50 py-2"><div className="font-mono text-lg font-bold text-[#1B3F94]">{p.sample_percent}%</div>random</div>
                    <div className="rounded bg-slate-50 py-2"><div className="font-mono text-lg font-bold text-[#1B3F94]">{p.active ? "On" : "Off"}</div>active</div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    {p.include_flagged && <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-600">flagged always sampled</span>}
                    {p.include_auto_fail && <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-600">auto-fails always sampled</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
      {editing && <PolicyDialog policy={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
