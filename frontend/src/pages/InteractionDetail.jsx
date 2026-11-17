import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, Loader2, RefreshCw, ThumbsUp, Wrench, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { ChannelTag, fmtDate, scoreColor } from "@/components/common";

function List({ icon: Icon, title, items, color, testId }) {
  return (
    <div className="card-surface p-6" data-testid={testId}>
      <div className="label-mono mb-3 flex items-center gap-2"><Icon className={`h-4 w-4 ${color}`} />{title}</div>
      <ul className="space-y-2 text-sm text-slate-600">{(items || []).map((s, i) => <li key={i}>• {s}</li>)}</ul>
    </div>
  );
}

export default function InteractionDetail() {
  const { id } = useParams();
  const api = useApi();
  const nav = useNavigate();
  const { isStaff } = useMe();
  const [it, setIt] = useState(null);
  const [articles, setArticles] = useState([]);
  const load = useCallback(() => api.get(`/interactions/${id}`).then((r) => setIt(r.data)).catch(() => setIt(false)), [api, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!it || it.status === "scored" || it.status === "failed") return;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [it, load]);
  useEffect(() => {
    if (it?.recommended_article_ids?.length) api.get("/kb/articles").then((r) => setArticles(r.data.filter((a) => it.recommended_article_ids.includes(a.id))));
  }, [it, api]);

  if (it === false) return <p className="text-slate-500">Interaction not found.</p>;
  if (!it) return <div className="label-mono">Loading…</div>;
  const rescore = async () => { try { await api.post(`/interactions/${id}/rescore`); toast.success("Re-scoring started"); load(); } catch (e) { toast.error(errMsg(e)); } };

  return (
    <div className="space-y-4">
      <Link to="/interactions" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#1B3F94]" data-testid="back-to-interactions"><ArrowLeft className="h-4 w-4" />Interactions</Link>
      <div className="card-surface flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="label-mono mb-2">{it.form_name} · {fmtDate(it.created_at)}</div>
          <h1 className="text-3xl font-extrabold tracking-tight" data-testid="interaction-agent-name">{it.agent_name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-500"><ChannelTag channel={it.channel} />{it.customer_name && <span>Customer: {it.customer_name}</span>}{it.customer_intent && <span>Intent: {it.customer_intent}</span>}</div>
        </div>
        {it.status === "scored" ? (
          <div className="flex items-center gap-8">
            <div><div className="label-mono">Sentiment</div><div className="mt-1 capitalize" data-testid="interaction-sentiment">{it.sentiment}</div></div>
            <div><div className="label-mono">CSAT</div><div className="mt-1 font-mono" data-testid="interaction-csat">{it.csat_predicted}/5</div></div>
            <div className="text-right"><div className="label-mono">QA score</div>
              <div data-testid="interaction-overall-score" className={`font-display text-5xl font-extrabold ${it.auto_failed ? "text-red-600" : scoreColor(it.overall_score)}`}>{it.auto_failed ? "FAIL" : `${it.overall_score}`}</div></div>
          </div>
        ) : it.status === "failed" ? (
          <div className="text-right"><div className="text-sm text-red-600" data-testid="interaction-error">Scoring failed: {it.error}</div>{isStaff && <Button size="sm" className="mt-2" onClick={rescore} data-testid="rescore-btn"><RefreshCw className="mr-1 h-3 w-3" />Retry</Button>}</div>
        ) : <div className="flex items-center gap-2 text-amber-600" data-testid="interaction-processing"><Loader2 className="h-5 w-5 animate-spin" />AI is {it.status}…</div>}
      </div>

      {it.status === "scored" && (<>
        {(it.auto_failed || it.compliance_flags?.length > 0) && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-5" data-testid="compliance-flag-alert">
            <div className="mb-2 flex items-center gap-2 font-semibold text-red-700"><AlertTriangle className="h-4 w-4" />{it.auto_failed ? "Auto-fail: a mandatory criterion was missed" : "Compliance risks detected"}</div>
            {it.compliance_flags.map((f, i) => (
              <div key={i} className="mt-2 text-sm"><span className="mr-2 rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-red-700">{f.severity}</span>{f.issue}{f.quote && <span className="ml-2 italic text-slate-500">“{f.quote}”</span>}</div>
            ))}
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="card-surface p-6 lg:col-span-7" data-testid="criteria-breakdown">
            <div className="label-mono mb-4">Rubric evaluation</div>
            <div className="space-y-5">
              {it.criteria_results.map((c) => (
                <div key={c.id}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium">{c.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}{c.name}{c.auto_fail && <span className="font-mono text-[10px] text-red-700">AUTO-FAIL</span>}</span>
                    <span className={`font-mono ${scoreColor(c.score)}`}>{c.score}</span>
                  </div>
                  <Progress value={c.score} className="h-1.5" />
                  <p className="mt-1.5 text-xs text-slate-500">{c.reason}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4 lg:col-span-5">
            <div className="card-surface p-6"><div className="label-mono mb-2">AI summary</div><p className="text-sm text-slate-600" data-testid="interaction-summary">{it.summary}</p></div>
            <List icon={ThumbsUp} title="Strengths" items={it.strengths} color="text-emerald-600" testId="interaction-strengths" />
            <List icon={Wrench} title="Coaching opportunities" items={it.improvements} color="text-amber-600" testId="interaction-improvements" />
            <div className="card-surface p-6" data-testid="recommended-articles">
              <div className="label-mono mb-3 flex items-center gap-2"><BookOpen className="h-4 w-4 text-[#1B3F94]" />Recommended knowledge</div>
              {articles.length ? articles.map((a) => <Link key={a.id} to={`/knowledge/${a.id}`} className="block py-1 text-sm text-[#1B3F94] hover:text-[#1B3F94]">{a.title} →</Link>) : <p className="text-sm text-slate-500">None</p>}
            </div>
            {isStaff && <Button className="w-full" data-testid="create-coaching-from-interaction-btn" onClick={() => nav(`/coaching?from=${it.id}`)}>Create coaching session</Button>}
          </div>
        </div>
      </>)}
      {it.transcript && (
        <div className="card-surface p-6"><div className="label-mono mb-3">Transcript {it.source === "audio" && `· from ${it.audio_name}`}</div>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-600" data-testid="interaction-transcript">{it.transcript}</pre></div>
      )}
    </div>
  );
}
