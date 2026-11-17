import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi, errMsg } from "@/lib/api";
import { Field, NativeSelect } from "@/components/common";

const nid = () => `n${Math.random().toString(36).slice(2, 7)}`;
const blankTree = () => { const id = nid(); return { title: "", description: "", category: "", start_node: id, nodes: [{ id, title: "Start", text: "", script: "", options: [] }] }; };

function NodeEditor({ n, i, nodes, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...n, [k]: v });
  const setOpt = (j, k, v) => set("options", n.options.map((o, x) => (x === j ? { ...o, [k]: v } : o)));
  const targets = nodes.filter((x) => x.id !== n.id).map((x) => ({ value: x.id, label: x.title || x.id }));
  return (
    <div className="card-surface space-y-3 p-5" data-testid={`tree-node-editor-${i}`}>
      <div className="flex items-center justify-between"><span className="label-mono">Step · {n.id}</span>
        <Button size="icon" variant="ghost" className="hover:text-white" onClick={onRemove} data-testid={`tree-node-remove-${i}`}><Trash2 className="h-4 w-4" /></Button></div>
      <Input placeholder="Step title" value={n.title} onChange={(e) => set("title", e.target.value)} data-testid={`tree-node-title-${i}`} />
      <Textarea rows={2} placeholder="What should the agent check or ask?" value={n.text} onChange={(e) => set("text", e.target.value)} data-testid={`tree-node-text-${i}`} />
      <Input placeholder="Script to say (optional)" value={n.script} onChange={(e) => set("script", e.target.value)} data-testid={`tree-node-script-${i}`} />
      <div className="label-mono">Branches {n.options.length === 0 && "· none = resolution step"}</div>
      {n.options.map((o, j) => (
        <div key={j} className="flex gap-2">
          <Input placeholder="If customer / answer…" value={o.label} onChange={(e) => setOpt(j, "label", e.target.value)} data-testid={`tree-node-${i}-option-label-${j}`} />
          <NativeSelect className="max-w-[45%]" value={o.next} onChange={(v) => setOpt(j, "next", v)} options={[{ value: "", label: "Go to…" }, ...targets]} testId={`tree-node-${i}-option-next-${j}`} />
          <Button size="icon" variant="ghost" className="shrink-0 hover:text-white" onClick={() => set("options", n.options.filter((_, x) => x !== j))}><Trash2 className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="hover:text-white" onClick={() => set("options", [...n.options, { label: "", next: "" }])} data-testid={`tree-node-add-option-${i}`}><Plus className="mr-1 h-3 w-3" />Add branch</Button>
    </div>
  );
}

export default function TreeEditor() {
  const { id } = useParams();
  const isNew = id === "new";
  const api = useApi();
  const nav = useNavigate();
  const [t, setT] = useState(isNew ? blankTree() : null);
  useEffect(() => { if (!isNew) api.get(`/trees/${id}`).then((r) => setT(r.data)); }, [api, id, isNew]);
  if (!t) return <div className="label-mono">Loading…</div>;
  const setNode = (i, n) => setT({ ...t, nodes: t.nodes.map((x, j) => (j === i ? n : x)) });
  const removeNode = (i) => {
    const gone = t.nodes[i].id;
    const nodes = t.nodes.filter((_, j) => j !== i).map((n) => ({ ...n, options: n.options.filter((o) => o.next !== gone) }));
    setT({ ...t, nodes, start_node: t.start_node === gone ? nodes[0]?.id || "" : t.start_node });
  };
  const save = async () => {
    try {
      const r = isNew ? await api.post("/trees", t) : await api.put(`/trees/${id}`, t);
      toast.success("Decision tree saved"); nav(`/trees/${r.data.id}`);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async () => { if (window.confirm("Delete this tree?")) { await api.delete(`/trees/${id}`); nav("/trees"); } };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link to="/trees" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Decision Trees</Link>
      <h1 className="text-3xl font-extrabold tracking-tight">{isNew ? "New decision tree" : "Edit decision tree"}</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title"><Input value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} data-testid="tree-title-input" /></Field>
        <Field label="Start step"><NativeSelect value={t.start_node} onChange={(v) => setT({ ...t, start_node: v })} options={t.nodes.map((n) => ({ value: n.id, label: n.title || n.id }))} testId="tree-start-select" /></Field>
      </div>
      <Field label="Description"><Input value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} data-testid="tree-desc-input" /></Field>
      <div className="space-y-4">{t.nodes.map((n, i) => <NodeEditor key={n.id} n={n} i={i} nodes={t.nodes} onChange={(v) => setNode(i, v)} onRemove={() => removeNode(i)} />)}</div>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" className="hover:text-white" onClick={() => setT({ ...t, nodes: [...t.nodes, { id: nid(), title: "", text: "", script: "", options: [] }] })} data-testid="tree-add-node-btn"><Plus className="mr-1 h-4 w-4" />Add step</Button>
        <div className="flex gap-2">{!isNew && <Button variant="ghost" className="hover:text-white" onClick={remove} data-testid="tree-delete-btn">Delete</Button>}
          <Button onClick={save} disabled={!t.title || !t.nodes.length} data-testid="tree-save-btn">Save tree</Button></div>
      </div>
    </div>
  );
}
