import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Copy, RotateCcw, CheckCircle2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";

export default function TreeRunner() {
  const { id } = useParams();
  const api = useApi();
  const [tree, setTree] = useState(null);
  const [path, setPath] = useState([]);
  useEffect(() => {
    api.get(`/trees/${id}`).then((r) => { setTree(r.data); setPath([{ node: r.data.start_node }]); api.post(`/trees/${id}/run`); }).catch(() => setTree(false));
  }, [api, id]);
  if (tree === false) return <p className="text-slate-400">Tree not found.</p>;
  if (!tree) return <div className="label-mono">Loading…</div>;
  const byId = Object.fromEntries(tree.nodes.map((n) => [n.id, n]));
  const current = byId[path[path.length - 1].node];
  const choose = (o) => setPath([...path.slice(0, -1), { ...path[path.length - 1], choice: o.label }, { node: o.next }]);
  const copy = () => { navigator.clipboard?.writeText(current.script); toast.success("Script copied"); };
  const isEnd = !current.options.length;

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/trees" className="mb-6 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white" data-testid="back-to-trees"><ArrowLeft className="h-4 w-4" />Decision Trees</Link>
      <h1 className="mb-8 text-3xl font-extrabold tracking-tight" data-testid="tree-title">{tree.title}</h1>
      <div className="grid gap-6 lg:grid-cols-12">
        <ol className="space-y-3 lg:col-span-4" data-testid="tree-history">
          {path.map((p, i) => (
            <li key={i} className={`border-l-2 pl-4 ${i === path.length - 1 ? "border-blue-500" : "border-white/10"}`}>
              <div className="label-mono">Step {i + 1}</div>
              <div className="text-sm font-medium">{byId[p.node]?.title}</div>
              {p.choice && <div className="text-xs text-cyan-400">→ {p.choice}</div>}
            </li>
          ))}
        </ol>
        <div className="lg:col-span-8">
          <div key={current.id} className={`card-surface p-8 fade-up ${isEnd ? "border-emerald-500/30" : "border-blue-500/30"}`} data-testid="tree-current-node">
            <div className="label-mono mb-2">{isEnd ? "Resolution" : `Step ${path.length}`}</div>
            <h2 className="flex items-center gap-2 text-2xl font-bold">{isEnd && <CheckCircle2 className="h-6 w-6 text-emerald-400" />}{current.title}</h2>
            {current.text && <p className="mt-3 text-slate-300">{current.text}</p>}
            {current.script && (
              <div className="mt-5 rounded-md border border-white/10 bg-[#0B0E14] p-4">
                <div className="mb-2 flex items-center justify-between"><span className="label-mono">Say to customer</span>
                  <button onClick={copy} className="text-slate-400 hover:text-white" data-testid="tree-copy-script-btn"><Copy className="h-4 w-4" /></button></div>
                <p className="text-sm italic text-slate-200" data-testid="tree-script">“{current.script}”</p>
              </div>
            )}
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {current.options.map((o, i) => (
                <Button key={i} variant="outline" className="h-auto justify-start whitespace-normal py-3 text-left hover:border-blue-500 hover:text-white" onClick={() => choose(o)} data-testid={`decision-tree-next-step-button-${i}`}>{o.label}</Button>
              ))}
            </div>
            <div className="mt-6 flex gap-2">
              {path.length > 1 && <Button variant="ghost" className="hover:text-white" onClick={() => setPath(path.slice(0, -1).map((p, i, arr) => (i === arr.length - 1 ? { node: p.node } : p)))} data-testid="tree-back-btn"><Undo2 className="mr-1 h-4 w-4" />Back</Button>}
              <Button variant="ghost" className="hover:text-white" onClick={() => setPath([{ node: tree.start_node }])} data-testid="tree-restart-btn"><RotateCcw className="mr-1 h-4 w-4" />Restart</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
