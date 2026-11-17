import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Field, fmtDate } from "@/components/common";
import { StepGuide } from "@/components/StepGuide";

const blank = { title: "", category: "", summary: "", content: "", steps: [], tags: [], self_service: true };

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

export default function Article() {
  const { id } = useParams();
  const isNew = id === "new";
  const api = useApi();
  const nav = useNavigate();
  const { isStaff } = useMe();
  const [a, setA] = useState(isNew ? blank : null);
  const [editing, setEditing] = useState(isNew);
  useEffect(() => { if (!isNew) api.get(`/kb/articles/${id}`).then((r) => setA(r.data)).catch(() => setA(false)); }, [api, id, isNew]);

  const save = async (body) => {
    try {
      const r = isNew ? await api.post("/kb/articles", body) : await api.put(`/kb/articles/${id}`, body);
      toast.success("Article saved"); setA(r.data); setEditing(false);
      if (isNew) nav(`/knowledge/${r.data.id}`, { replace: true });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async () => { if (!window.confirm("Delete this article?")) return; await api.delete(`/kb/articles/${id}`); nav("/knowledge"); };

  if (a === false) return <p className="text-slate-500">Article not found.</p>;
  if (!a) return <div className="label-mono">Loading…</div>;
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
            </div>
            {isStaff && <div className="flex gap-2"><Button variant="outline" className="hover:text-[#1B3F94]" onClick={() => setEditing(true)} data-testid="article-edit-btn"><Pencil className="mr-1 h-4 w-4" />Edit</Button>
              <Button variant="ghost" className="hover:text-[#1B3F94]" onClick={remove} data-testid="article-delete-btn"><Trash2 className="h-4 w-4" /></Button></div>}
          </div>
          {a.content && <div className="card-surface whitespace-pre-wrap p-6 text-sm leading-relaxed text-slate-700" data-testid="article-content">{a.content}</div>}
          <StepGuide steps={a.steps} />
          {a.tags?.length > 0 && <div className="flex flex-wrap gap-2">{a.tags.map((t) => <span key={t} className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-500">#{t}</span>)}</div>}
        </article>
      )}
    </div>
  );
}
