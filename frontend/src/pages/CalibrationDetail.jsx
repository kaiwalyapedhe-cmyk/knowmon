import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { AudioTranscript } from "@/components/AudioTranscript";
import { scoreColor } from "@/components/common";

const spreadTone = (v) => (v >= 25 ? "bg-red-100 text-red-700" : v >= 10 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700");

function ScoreForm({ cal, initial, label, onSubmit, testPrefix, children }) {
  const [vals, setVals] = useState(() => Object.fromEntries(cal.criteria.map((c) => [c.id, { score: String(initial?.[c.id]?.score ?? ""), note: initial?.[c.id]?.note || "" }])));
  const set = (id, k, v) => setVals({ ...vals, [id]: { ...vals[id], [k]: v } });
  const valid = cal.criteria.every((c) => vals[c.id].score !== "" && +vals[c.id].score >= 0 && +vals[c.id].score <= 100);
  return (
    <div className="space-y-3" data-testid={`${testPrefix}-form`}>
      {cal.criteria.map((c) => (
        <div key={c.id} className="grid gap-2 border-t border-slate-200 pt-3 sm:grid-cols-12">
          <div className="text-sm font-medium sm:col-span-4">{c.name}<div className="text-xs text-slate-400">{c.type === "binary" ? "0 = fail, 100 = pass" : "0-100"}{c.auto_fail && " · auto-fail"}</div></div>
          <Input type="number" min="0" max="100" className="sm:col-span-2" value={vals[c.id].score} onChange={(e) => set(c.id, "score", e.target.value)} data-testid={`${testPrefix}-score-${c.id}`} />
          <Input className="sm:col-span-6" placeholder="Why? (optional)" value={vals[c.id].note} onChange={(e) => set(c.id, "note", e.target.value)} data-testid={`${testPrefix}-note-${c.id}`} />
        </div>
      ))}
      {children}
      <Button disabled={!valid} onClick={() => onSubmit(cal.criteria.map((c) => ({ id: c.id, score: Number(vals[c.id].score), note: vals[c.id].note })))} data-testid={`${testPrefix}-submit-btn`}>{label}</Button>
    </div>
  );
}

function Comparison({ cal }) {
  const final = Object.fromEntries((cal.final?.criteria || []).map((c) => [c.id, c.score]));
  return (
    <div className="card-surface overflow-x-auto p-6" data-testid="calibration-comparison">
      <div className="label-mono mb-4">Side-by-side scores</div>
      <table className="w-full min-w-[560px] text-sm">
        <thead><tr className="text-left text-xs text-slate-500"><th className="pb-2">Criterion</th><th className="pb-2">AI</th>{cal.scores.map((s) => <th key={s.user_id} className="pb-2">{s.name}</th>)}{cal.final && <th className="pb-2 text-[#1B3F94]">Agreed</th>}<th className="pb-2 text-right">Spread</th></tr></thead>
        <tbody>
          {cal.criteria.map((c) => (
            <tr key={c.id} className="border-t border-slate-200" data-testid={`comparison-row-${c.id}`}>
              <td className="py-2.5 font-medium">{c.name}</td>
              <td className={`py-2.5 font-mono ${scoreColor(c.ai_score)}`} title={c.ai_reason}>{c.ai_score}</td>
              {cal.scores.map((s) => { const x = s.criteria.find((y) => y.id === c.id); return <td key={s.user_id} className={`py-2.5 font-mono ${scoreColor(x.score)}`} title={x.note}>{x.score}</td>; })}
              {cal.final && <td className="py-2.5 font-mono font-bold text-[#1B3F94]">{final[c.id]}</td>}
              <td className="py-2.5 text-right"><span className={`rounded px-2 py-0.5 font-mono text-xs ${spreadTone(cal.spread[c.id] || 0)}`}>±{cal.spread[c.id] ?? 0}</span></td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 font-semibold"><td className="py-2.5">Overall</td><td className="py-2.5 font-mono">{cal.ai_overall}</td>
            {cal.scores.map((s) => <td key={s.user_id} className="py-2.5 font-mono">{s.overall}</td>)}{cal.final && <td className="py-2.5 font-mono text-[#1B3F94]" data-testid="calibration-agreed-overall">{cal.final.overall}</td>}<td /></tr>
        </tbody>
      </table>
    </div>
  );
}

export default function CalibrationDetail() {
  const { id } = useParams();
  const api = useApi();
  const { me, isAdmin } = useMe();
  const player = useRef(null);
  const [cal, setCal] = useState(null);
  const [it, setIt] = useState(null);
  const [note, setNote] = useState("");
  const [apply, setApply] = useState(true);
  const load = useCallback(() => api.get(`/calibrations/${id}`).then((r) => { setCal(r.data); return r.data; }), [api, id]);
  useEffect(() => { load().then((c) => api.get(`/interactions/${c.interaction_id}`).then((r) => setIt(r.data))).catch(() => setCal(false)); }, [load, api]);

  const submit = async (criteria) => { try { setCal((await api.post(`/calibrations/${id}/score`, { criteria })).data); toast.success("Your scores are in"); } catch (e) { toast.error(errMsg(e)); } };
  const close = async (criteria) => { try { setCal((await api.post(`/calibrations/${id}/close`, { criteria, note, apply_to_interaction: apply })).data); toast.success("Standard agreed"); } catch (e) { toast.error(errMsg(e)); } };

  if (cal === false) return <p className="text-slate-500">Session not found.</p>;
  if (!cal) return <div className="label-mono">Loading…</div>;
  const mine = Object.fromEntries((cal.scores.find((s) => s.user_id === me.user_id)?.criteria || []).map((c) => [c.id, c]));
  const avg = Object.fromEntries(cal.criteria.map((c) => {
    const v = cal.scores.map((s) => s.criteria.find((x) => x.id === c.id).score);
    return [c.id, { score: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : c.ai_score, note: "" }];
  }));
  const isOwner = cal.created_by === me.user_id || isAdmin;
  const canScore = cal.status === "open" && cal.participant_ids.includes(me.user_id);

  return (
    <div className="space-y-4">
      <Link to="/calibration" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#1B3F94]" data-testid="back-to-calibration"><ArrowLeft className="h-4 w-4" />Calibration</Link>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div><div className="label-mono mb-1">{cal.status === "open" ? `Open · ${cal.submitted_count}/${cal.participant_ids.length} scored` : `Agreed by ${cal.final.by_name}`}</div>
          <h1 className="text-3xl font-extrabold tracking-tight" data-testid="calibration-title">{cal.title}</h1></div>
        <Link to={`/interactions/${cal.interaction_id}`} className="text-sm text-[#1B3F94] hover:text-[#E31E24]">Open interaction →</Link>
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5">{it && <AudioTranscript ref={player} interaction={it} />}</div>
        <div className="space-y-4 lg:col-span-7">
          {canScore && (
            <div className="card-surface p-6">
              <div className="label-mono mb-2">{cal.submitted ? "Your scores (you can update them)" : "Score this call blind"}</div>
              {!cal.submitted && <p className="mb-2 text-sm text-slate-500">Other reviewers' and the AI's scores unlock once you submit.</p>}
              <ScoreForm key={cal.submitted ? "mine" : "new"} cal={cal} initial={mine} label={cal.submitted ? "Update my scores" : "Submit my scores"} onSubmit={submit} testPrefix="calibration-my" />
            </div>
          )}
          {cal.revealed ? <Comparison cal={cal} /> : (
            <div className="card-surface flex items-center gap-3 p-6 text-sm text-slate-500" data-testid="calibration-locked"><Lock className="h-4 w-4" />Scores are hidden until you submit yours.</div>
          )}
          {cal.status === "open" && isOwner && cal.scores.length > 0 && (
            <div className="card-surface border-t-4 border-t-[#1B3F94] p-6">
              <div className="label-mono mb-2">Agree the standard</div>
              <p className="mb-2 text-sm text-slate-500">Pre-filled with the reviewers' average. Adjust after discussion, then close the session.</p>
              <ScoreForm key={cal.scores.length} cal={cal} initial={avg} label="Close & agree standard" onSubmit={close} testPrefix="calibration-final">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the group agree? (shared guidance for future scoring)" data-testid="calibration-final-note-input" />
                <label className="flex items-center gap-2 text-sm"><Switch checked={apply} onCheckedChange={setApply} data-testid="calibration-apply-switch" />Replace the interaction's score with the agreed score</label>
              </ScoreForm>
            </div>
          )}
          {cal.final?.note && <div className="card-surface p-6"><div className="label-mono mb-2">Agreed guidance</div><p className="whitespace-pre-wrap text-sm text-slate-600" data-testid="calibration-final-note">{cal.final.note}</p></div>}
        </div>
      </div>
    </div>
  );
}
