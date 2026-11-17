import { useState } from "react";
import { Scale } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { fmtDate } from "@/components/common";

function RaiseForm({ it, onDone }) {
  const api = useApi();
  const [reason, setReason] = useState("");
  const [crit, setCrit] = useState([]);
  const submit = async () => {
    try { await api.post(`/interactions/${it.id}/dispute`, { reason, criterion_ids: crit }); toast.success("Dispute sent for review"); onDone(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="space-y-3" data-testid="dispute-raise-form">
      <p className="text-sm text-slate-500">Think this score is wrong? Tell your team lead why.</p>
      <div className="space-y-1.5">
        {it.criteria_results.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm"><Checkbox checked={crit.includes(c.id)} data-testid={`dispute-criterion-${c.id}`}
            onCheckedChange={() => setCrit(crit.includes(c.id) ? crit.filter((x) => x !== c.id) : [...crit, c.id])} />{c.name} <span className="font-mono text-xs text-slate-400">{c.score}</span></label>
        ))}
      </div>
      <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. I did verify the customer at 0:42 — the AI missed it." data-testid="dispute-reason-input" />
      <Button onClick={submit} disabled={reason.trim().length < 5} data-testid="dispute-submit-btn">Raise dispute</Button>
    </div>
  );
}

function ResolveForm({ it, onDone }) {
  const api = useApi();
  const [score, setScore] = useState(String(it.overall_score));
  const [note, setNote] = useState("");
  const resolve = async (decision) => {
    try {
      await api.post(`/interactions/${it.id}/dispute/resolve`, { decision, note, new_score: decision === "accepted" ? Number(score) : null });
      toast.success(decision === "accepted" ? "Dispute accepted, score updated" : "Dispute rejected"); onDone();
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="space-y-3" data-testid="dispute-resolve-form">
      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Decision note for the agent" data-testid="dispute-note-input" />
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" min="0" max="100" value={score} onChange={(e) => setScore(e.target.value)} className="w-28" data-testid="dispute-new-score-input" />
        <Button onClick={() => resolve("accepted")} disabled={score === "" || Number(score) < 0 || Number(score) > 100} data-testid="dispute-accept-btn">Accept with new score</Button>
        <Button variant="outline" className="hover:text-[#E31E24]" onClick={() => resolve("rejected")} data-testid="dispute-reject-btn">Reject</Button>
      </div>
    </div>
  );
}

export function DisputePanel({ it, onChange }) {
  const { me, isStaff } = useMe();
  const d = it.dispute;
  const canRaise = it.agent_id === me.user_id && it.status === "scored" && d?.status !== "open";
  if (!d && !canRaise) return null;
  const names = Object.fromEntries((it.criteria_results || []).map((c) => [c.id, c.name]));
  return (
    <div className={`card-surface p-6 ${d?.status === "open" ? "border-amber-500/50" : ""}`} data-testid="dispute-panel">
      <div className="label-mono mb-3 flex items-center gap-2"><Scale className="h-4 w-4" />Score dispute {d && `· ${d.status === "open" ? "awaiting review" : d.decision}`}</div>
      {d && (
        <div className="mb-4 space-y-2 text-sm" data-testid="dispute-details">
          <p><span className="font-semibold">{d.raised_by_name}</span> <span className="text-slate-500">· {fmtDate(d.raised_at)} · score was {d.score_at_dispute}</span></p>
          <p className="whitespace-pre-wrap text-slate-600">“{d.reason}”</p>
          {d.criterion_ids?.length > 0 && <p className="text-xs text-slate-500">Criteria: {d.criterion_ids.map((c) => names[c]).join(", ")}</p>}
          {d.status === "resolved" && (
            <p className={d.decision === "accepted" ? "text-emerald-600" : "text-red-600"} data-testid="dispute-outcome">
              {d.decision === "accepted" ? `Accepted · new score ${d.new_score}` : "Rejected"} by {d.resolved_by_name}{d.note && ` — ${d.note}`}
            </p>
          )}
        </div>
      )}
      {d?.status === "open" && isStaff && <ResolveForm it={it} onDone={onChange} />}
      {canRaise && <RaiseForm it={it} onDone={onChange} />}
    </div>
  );
}
