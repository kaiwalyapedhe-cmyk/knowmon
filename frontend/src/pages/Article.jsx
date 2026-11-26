import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Archive, CheckCircle2, History, Pencil, Plus, RotateCcw, Send, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Field, fmtDate } from "@/components/common";
import { StepGuide } from "@/components/StepGuide";

const blank = { title: "", category: "", summary: "", content: "", steps: [], tags: [], self_service: true, review_date: "", expires_at: "" };
const STATUS_STYLE = { draft: "bg-slate-100 text-slate-600", in_review: "bg-amber-100 text-amber-700", approved: "bg-[#1B3F94]/10 text-[#1B3F94]", published: "bg-emerald-100 text-emerald-700", archived: "bg-rose-50 text-rose-600" };

function Editor({ initial, onSave, onCancel }) {
  const [f, setF] = useState({ ...initial, tagsText: (initial.tags || []).join(", ") });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setStep = (i, k, v) => setF({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  const submit = () => { const { tagsText, ...rest } = f; onSave({ ...rest, tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean) }); };
  return (
    <div className="space-y-4" data-testid="article-editor">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title"><Input value={f.title} onChange={set("title")} data-testid="article-title-input" /></Field>
        <Field label="Category"><Input value={f.category} onChange={set("category")} data-testid="article-category-input" placeholder="e.g. Billing" /></Field>
      </div>
      <Field label="Summary"><Input value={f.summary} onChange={set("summary")} data-testid="article-summary-input" /></Field>
      <Field label="Content"><Textarea rows={6} value={f.content} onChange={set("content")} data-testid="article-content-input" /></Field>
      <Field label="Tags (comma separated)"><Input value={f.tagsText} onChange={set("tagsText")} data-testid="article-tags-input" /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Next review date"><Input type="date" value={f.review_date || ""} onChange={set("review_date")} data-testid="article-review-date" /></Field>
        <Field label="Expires on"><Input type="date" value={f.expires_at || ""} onChange={set("expires_at")} data-testid="article-expiry-date" /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={f.self_service} onCheckedChange={(v) => setF({ ...f, self_service: v })} data-testid="article-self-service-switch" />Publish to customer self-service portal</label>
      <div className="label-mono">Visual how-to steps</div>
      {f.steps.map((s, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-3" data-testid={`article-step-editor-${i}`}>
          <div className="flex gap-2"><Input placeholder={`Step ${i + 1} title`} value={s.title} onChange={(e) => setStep(i, "title", e.target.value)} data-testid={`step-title-${i}`} />
            <Button variant="ghost" size="icon" className="hover:text-[#1B3F94]" onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })} data-testid={`step-remove-${i}`}><Trash2 className="h-4 w-4" /></Button></div>
          <Textarea rows={2} placeholder="Instructions" value={s.body} onChange={(e) => setStep(i, "body", e.target.value)} data-testid={`step-body-${i}`} />
          <Input placeholder="Image or video thumbnail URL (optional)" value={s.image_url} onChange={(e) => setStep(i, "image_url", e.target.value)} data-testid={`step-image-${i}`} />
        </div>
      ))}
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" className="hover:text-[#1B3F94]" onClick={() => setF({ ...f, steps: [...f.steps, { title: "", body: "", image_url: "" }] })} data-testid="add-step-btn"><Plus className="mr-1 h-4 w-4" />Add step</Button>
        <div className="flex gap-2"><Button variant="ghost" className="hover:text-[#1B3F94]" onClick={onCancel} data-testid="article-cancel-btn">Cancel</Button>
          <Button onClick={submit} disabled={!f.title || !f.category} data-testid="article-save-btn">Save article</Button></div>
      </div>
    </div>
  );
}

function VersionPanel({ articleId, onRestored }) {
  const api = useApi();
  const [versions, setVersions] = useState(null);
  useEffect(() => { api.get(`/kb/articles/${articleId}/versions`).then((r) => setVersions(r.data)).catch((e) => toast.error(errMsg(e))); }, [api, articleId]);
  const restore = async (v) => {
    if (!window.confirm(`Restore version ${v.version}? The current version is kept in history.`)) return;
    try { await api.post(`/kb/articles/${articleId}/versions/${v.id}/restore`, {}); toast.success(`Version ${v.version} restored`); onRestored(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="card-surface p-5" data-testid="article-versions">
      <div className="label-mono mb-3">Revision history</div>
      {versions === null ? <div className="label-mono">Loading…</div> : versions.length === 0 ? <p className="text-sm text-slate-500">No versions recorded yet.</p> : (
        <ul className="space-y-2 text-sm">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2 first:border-0 first:pt-0">
              <span><span className="font-mono text-xs font-semibold text-[#1B3F94]">v{v.version}</span> · {v.title} {v.note && <span className="text-slate-500">— {v.note}</span>}</span>
              <span className="flex items-center gap-2 text-xs text-slate-500">{v.by_name || "—"} · {fmtDate(v.at)}
                <Button size="sm" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => restore(v)}><RotateCcw className="mr-1 h-3.5 w-3.5" />Restore</Button></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Article() {
  const { id } = useParams();
  const isNew = id === "new";
  const api = useApi();
  const nav = useNavigate();
  const { isStaff, isQA } = useMe();
  const [a, setA] = useState(isNew ? blank : null);
  const [editing, setEditing] = useState(isNew);
  const [showVersions, setShowVersions] = useState(false);
  const [myFeedback, setMyFeedback] = useState(null);
  const load = () => api.get(`/kb/articles/${id}`).then((r) => setA(r.data)).catch(() => setA(false));
  useEffect(() => { if (!isNew) load(); }, [api, id, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (body) => {
    try {
      const r = isNew ? await api.post("/kb/articles", body) : await api.put(`/kb/articles/${id}`, body);
      toast.success(isNew ? "Draft created — submit it for review when ready" : "Article saved");
      setA(r.data); setEditing(false);
      if (isNew) nav(`/knowledge/${r.data.id}`, { replace: true });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async () => { if (!window.confirm("Delete this article?")) return; await api.delete(`/kb/articles/${id}`); nav("/knowledge"); };
  const transition = async (action, label) => {
    try { const r = await api.post(`/kb/articles/${id}/${action}`, {}); setA(r.data); toast.success(label); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const rate = async (helpful) => {
    try {
      const r = await api.post(`/kb/articles/${id}/feedback`, { helpful });
      setA({ ...a, helpful_count: r.data.helpful_count, not_helpful_count: r.data.not_helpful_count });
      setMyFeedback(helpful);
      toast.success("Thanks — feedback recorded");
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (a === false) return <p className="text-slate-500">Article not found.</p>;
  if (!a) return <div className="label-mono">Loading…</div>;
  const status = a.status || "published";
  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/knowledge" className="mb-6 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#1B3F94]" data-testid="back-to-knowledge"><ArrowLeft className="h-4 w-4" />Knowledge Hub</Link>
      {editing ? <Editor initial={a} onSave={save} onCancel={() => (isNew ? nav("/knowledge") : setEditing(false))} /> : (
        <article className="space-y-6 fade-up">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="label-mono mb-2 text-[#E31E24]">{a.category} · updated {fmtDate(a.updated_at)}</div>
              <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl" data-testid="article-title">{a.title}</h1>
              {a.summary && <p className="mt-2 text-slate-500">{a.summary}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span data-testid="article-status" className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[status]}`}>{status.replace("_", " ")}</span>
                <span className="font-mono">v{a.version || 1}</span>
                <span>Owner {a.owner_name || "—"}</span>
                {a.review_date && <span>· next review {a.review_date}</span>}
                {a.expires_at && <span>· expires {a.expires_at}</span>}
              </div>
            </div>
            {isStaff && <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="hover:text-[#1B3F94]" onClick={() => setEditing(true)} data-testid="article-edit-btn"><Pencil className="mr-1 h-4 w-4" />Edit</Button>
              <Button variant="ghost" className="hover:text-[#1B3F94]" onClick={() => setShowVersions((v) => !v)} data-testid="article-history-btn"><History className="mr-1 h-4 w-4" />History</Button>
              <Button variant="ghost" className="hover:text-[#1B3F94]" onClick={remove} data-testid="article-delete-btn"><Trash2 className="h-4 w-4" /></Button>
            </div>}
          </div>

          {isStaff && <div className="card-surface flex flex-wrap items-center gap-2 p-4" data-testid="article-lifecycle">
            <span className="label-mono mr-2">Lifecycle</span>
            {(status === "draft" || status === "archived") && <Button size="sm" onClick={() => transition("submit", "Submitted for review")} data-testid="article-submit-btn"><Send className="mr-1 h-3.5 w-3.5" />Submit for review</Button>}
            {status === "in_review" && isQA && <Button size="sm" onClick={() => transition("approve", "Article approved")} data-testid="article-approve-btn"><CheckCircle2 className="mr-1 h-3.5 w-3.5" />Approve</Button>}
            {status === "approved" && <Button size="sm" onClick={() => transition("publish", "Article published")} data-testid="article-publish-btn">Publish</Button>}
            {status === "published" && <Button size="sm" variant="outline" className="hover:text-[#E31E24]" onClick={() => transition("archive", "Article archived")} data-testid="article-archive-btn"><Archive className="mr-1 h-3.5 w-3.5" />Archive</Button>}
            {status === "archived" && <Button size="sm" variant="outline" onClick={() => transition("reopen", "Article reopened as draft")} data-testid="article-reopen-btn"><RotateCcw className="mr-1 h-3.5 w-3.5" />Reopen</Button>}
            {a.approver_name && (status === "approved" || status === "published") && <span className="ml-auto text-xs text-slate-500">Approved by {a.approver_name}</span>}
          </div>}

          {showVersions && isStaff && <VersionPanel articleId={a.id} onRestored={load} />}

          {a.content && <div className="card-surface whitespace-pre-wrap p-6 text-sm leading-relaxed text-slate-700" data-testid="article-content">{a.content}</div>}
          <StepGuide steps={a.steps} />
          {a.tags?.length > 0 && <div className="flex flex-wrap gap-2">{a.tags.map((t) => <span key={t} className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-500">#{t}</span>)}</div>}

          <div className="card-surface flex flex-wrap items-center justify-between gap-3 p-5">
            <span className="text-sm text-slate-600">Was this article helpful?</span>
            <div className="flex gap-2">
              <Button variant={myFeedback === true ? "default" : "outline"} size="sm" onClick={() => rate(true)} data-testid="article-helpful-btn"><ThumbsUp className="mr-1 h-4 w-4" />{a.helpful_count || 0}</Button>
              <Button variant={myFeedback === false ? "default" : "outline"} size="sm" onClick={() => rate(false)} data-testid="article-unhelpful-btn"><ThumbsDown className="mr-1 h-4 w-4" />{a.not_helpful_count || 0}</Button>
            </div>
          </div>
        </article>
      )}
    </div>
  );
}
