import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Trash2, Calendar, BookOpen, GraduationCap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Empty, Field, NativeSelect, PageHeader, fmtDate } from "@/components/common";

const STATUSES = [{ value: "scheduled", label: "Scheduled" }, { value: "in_progress", label: "In progress" }, { value: "completed", label: "Completed" }];
const blank = { agent_id: "", agent_name: "", interaction_id: "", scheduled_for: "", focus: "", notes: "", status: "scheduled", action_items: [], article_ids: [], course_ids: [] };

function Picker({ label, items, selected, onToggle, testPrefix }) {
  return (
    <Field label={label}>
      <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-md border border-white/10 p-2">
        {items.map((x) => (
          <label key={x.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selected.includes(x.id)} onCheckedChange={() => onToggle(x.id)} data-testid={`${testPrefix}-${x.id}`} />{x.title}</label>
        ))}
      </div>
    </Field>
  );
}

function SessionDialog({ initial, onClose, onSaved }) {
  const api = useApi();
  const [f, setF] = useState(initial);
  const [people, setPeople] = useState([]);
  const [articles, setArticles] = useState([]);
  const [courses, setCourses] = useState([]);
  const [item, setItem] = useState("");
  useEffect(() => {
    api.get("/people").then((r) => setPeople(r.data));
    api.get("/kb/articles").then((r) => setArticles(r.data));
    api.get("/courses").then((r) => setCourses(r.data));
  }, [api]);
  const toggle = (k, id) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  const pickAgent = (id) => setF({ ...f, agent_id: id, agent_name: people.find((p) => p.user_id === id)?.name || f.agent_name });
  const save = async () => {
    try {
      if (f.id) await api.put(`/coaching/${f.id}`, f); else await api.post("/coaching", f);
      toast.success("Coaching session saved"); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="coaching-dialog">
        <DialogHeader><DialogTitle>{f.id ? "Edit coaching session" : "New coaching session"}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agent account"><NativeSelect testId="coaching-agent-select" value={f.agent_id} onChange={pickAgent} options={[{ value: "", label: "Not linked (type name)" }, ...people.map((p) => ({ value: p.user_id, label: p.name }))]} /></Field>
          <Field label="Agent name"><Input value={f.agent_name} onChange={(e) => setF({ ...f, agent_name: e.target.value })} data-testid="coaching-agent-name-input" /></Field>
          <Field label="Focus area"><Input value={f.focus} onChange={(e) => setF({ ...f, focus: e.target.value })} data-testid="coaching-focus-input" placeholder="e.g. Identity verification" /></Field>
          <Field label="Scheduled for"><Input type="datetime-local" value={f.scheduled_for} onChange={(e) => setF({ ...f, scheduled_for: e.target.value })} data-testid="coaching-date-input" /></Field>
          <Field label="Status"><NativeSelect testId="coaching-status-select" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={STATUSES} /></Field>
        </div>
        <Field label="Notes"><Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} data-testid="coaching-notes-input" /></Field>
        <Field label="Action items">
          <div className="space-y-1.5">
            {f.action_items.map((a, i) => (
              <div key={i} className="flex items-center justify-between rounded border border-white/10 px-3 py-1.5 text-sm"><span>{a.text}</span>
                <button onClick={() => setF({ ...f, action_items: f.action_items.filter((_, j) => j !== i) })} data-testid={`coaching-item-remove-${i}`}><Trash2 className="h-3.5 w-3.5 text-slate-500 hover:text-white" /></button></div>
            ))}
            <div className="flex gap-2"><Input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Add an action item" data-testid="coaching-item-input" />
              <Button variant="outline" className="hover:text-white" data-testid="coaching-item-add-btn" onClick={() => { if (item.trim()) { setF({ ...f, action_items: [...f.action_items, { text: item.trim(), done: false }] }); setItem(""); } }}>Add</Button></div>
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Picker label="Assign knowledge articles" items={articles} selected={f.article_ids} onToggle={(id) => toggle("article_ids", id)} testPrefix="coaching-article" />
          <Picker label="Assign training courses" items={courses} selected={f.course_ids} onToggle={(id) => toggle("course_ids", id)} testPrefix="coaching-course" />
        </div>
        <Button onClick={save} disabled={!f.agent_name || !f.focus} data-testid="coaching-save-btn">Save session</Button>
      </DialogContent>
    </Dialog>
  );
}

function SessionCard({ s, isStaff, onEdit, onReload, titles }) {
  const api = useApi();
  const toggle = async (i, done) => { try { await api.patch(`/coaching/${s.id}/items/${i}`, { done }); onReload(); } catch (e) { toast.error(errMsg(e)); } };
  const done = s.action_items.filter((a) => a.done).length;
  return (
    <div className="card-surface p-6" data-testid={`coaching-card-${s.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="label-mono mb-1">{s.status.replace("_", " ")} · coach {s.coach_name}</div>
          <h3 className="text-lg font-semibold">{s.agent_name} — {s.focus}</h3>
          {s.scheduled_for && <div className="mt-1 flex items-center gap-1 text-xs text-slate-400"><Calendar className="h-3 w-3" />{fmtDate(s.scheduled_for)}</div>}
        </div>
        <div className="text-right font-mono text-xs text-slate-400">{done}/{s.action_items.length} done</div>
      </div>
      {s.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{s.notes}</p>}
      <div className="mt-4 space-y-1.5">
        {s.action_items.map((a, i) => (
          <label key={i} className="flex items-center gap-2 text-sm"><Checkbox checked={a.done} onCheckedChange={(v) => toggle(i, !!v)} data-testid={`coaching-${s.id}-item-${i}`} /><span className={a.done ? "text-slate-500 line-through" : ""}>{a.text}</span></label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {s.article_ids.map((id) => <Link key={id} to={`/knowledge/${id}`} className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-1 text-blue-300 hover:text-blue-200"><BookOpen className="h-3 w-3" />{titles[id] || "Article"}</Link>)}
        {s.course_ids.map((id) => <Link key={id} to={`/training/${id}`} className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-300 hover:text-amber-200"><GraduationCap className="h-3 w-3" />{titles[id] || "Course"}</Link>)}
        {s.interaction_id && <Link to={`/interactions/${s.interaction_id}`} className="rounded-full bg-white/5 px-2.5 py-1 text-slate-300 hover:text-white">Linked interaction →</Link>}
      </div>
      {isStaff && <div className="mt-4 flex gap-2"><Button size="sm" variant="outline" className="hover:text-white" onClick={() => onEdit(s)} data-testid={`coaching-edit-${s.id}`}>Edit</Button>
        <Button size="sm" variant="ghost" className="hover:text-white" data-testid={`coaching-delete-${s.id}`} onClick={async () => { if (window.confirm("Delete session?")) { await api.delete(`/coaching/${s.id}`); onReload(); } }}>Delete</Button></div>}
    </div>
  );
}

export default function Coaching() {
  const api = useApi();
  const { isStaff } = useMe();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);
  const [titles, setTitles] = useState({});
  const load = useCallback(() => api.get("/coaching").then((r) => setItems(r.data)), [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    Promise.all([api.get("/kb/articles"), api.get("/courses")]).then(([a, c]) => setTitles(Object.fromEntries([...a.data, ...c.data].map((x) => [x.id, x.title]))));
  }, [api]);
  useEffect(() => {
    const from = params.get("from");
    if (!from || !isStaff) return;
    api.get(`/interactions/${from}`).then(({ data: it }) => {
      setEditing({ ...blank, agent_id: it.agent_id, agent_name: it.agent_name, interaction_id: it.id,
        focus: it.criteria_results?.filter((c) => !c.passed).map((c) => c.name).join(", ") || "Quality improvement",
        notes: it.summary || "", action_items: (it.improvements || []).map((t) => ({ text: t, done: false })), article_ids: it.recommended_article_ids || [] });
      setParams({}, { replace: true });
    });
  }, [params, api, isStaff, setParams]);

  return (
    <div>
      <PageHeader eyebrow="Agent development" title="Coaching" desc="Turn AutoQA findings into 1-on-1 sessions with action items, linked knowledge and training.">
        {isStaff && <Button onClick={() => setEditing(blank)} data-testid="coaching-session-create-btn"><Plus className="mr-1 h-4 w-4" />New session</Button>}
      </PageHeader>
      {items === null ? <div className="label-mono">Loading…</div> : items.length === 0 ? <Empty testId="coaching-empty" text={isStaff ? "No coaching sessions yet. Create one from an interaction or here." : "No coaching sessions assigned to you yet."} /> : (
        <div className="grid gap-4 lg:grid-cols-2">{items.map((s) => <SessionCard key={s.id} s={s} isStaff={isStaff} onEdit={setEditing} onReload={load} titles={titles} />)}</div>
      )}
      {editing && <SessionDialog initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
