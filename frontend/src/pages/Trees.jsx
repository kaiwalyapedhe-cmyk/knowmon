import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GitBranch, Play, Plus, Sparkles, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Empty, Field, PageHeader } from "@/components/common";

function GenerateDialog({ open, onOpenChange }) {
  const api = useApi();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [sop, setSop] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api.post("/trees/generate", { title, sop }); toast.success("Decision tree created"); nav(`/trees/${r.data.id}/edit`); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="generate-tree-dialog">
        <DialogHeader><DialogTitle>Generate a decision tree from an SOP</DialogTitle></DialogHeader>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="generate-tree-title-input" placeholder="e.g. SIM replacement process" /></Field>
        <Field label="Paste the SOP"><Textarea rows={10} value={sop} onChange={(e) => setSop(e.target.value)} data-testid="generate-tree-sop-input" /></Field>
        <Button onClick={go} disabled={busy || !title || sop.length < 20} data-testid="generate-tree-submit-btn">{busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />AI is building the flow…</> : <><Sparkles className="mr-2 h-4 w-4" />Generate</>}</Button>
      </DialogContent>
    </Dialog>
  );
}

export default function Trees() {
  const api = useApi();
  const nav = useNavigate();
  const { isStaff } = useMe();
  const [items, setItems] = useState(null);
  const [gen, setGen] = useState(false);
  const load = useCallback(() => api.get("/trees").then((r) => setItems(r.data)), [api]);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <PageHeader eyebrow="Cognitive decision trees" title="Decision Trees" desc="Interactive SOP workflows that guide agents to the next best action, step by step.">
        {isStaff && <>
          <Button variant="outline" className="hover:text-white" onClick={() => setGen(true)} data-testid="generate-tree-btn"><Sparkles className="mr-1 h-4 w-4" />Generate from SOP</Button>
          <Button onClick={() => nav("/trees/new/edit")} data-testid="new-tree-btn"><Plus className="mr-1 h-4 w-4" />New tree</Button>
        </>}
      </PageHeader>
      {items === null ? <div className="label-mono">Loading…</div> : items.length === 0 ? <Empty testId="trees-empty" text="No decision trees yet." /> : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((t) => (
            <div key={t.id} className="card-surface card-hover flex flex-col p-6" data-testid={`tree-card-${t.id}`}>
              <GitBranch className="mb-4 h-5 w-5 text-violet-400" />
              <h3 className="text-lg font-semibold">{t.title}</h3>
              <p className="mt-1 flex-1 text-sm text-slate-400">{t.description}</p>
              <div className="mt-3 font-mono text-xs text-slate-500">{t.nodes.length} steps · {t.runs} runs</div>
              <div className="mt-4 flex gap-2">
                <Link to={`/trees/${t.id}`} className="flex-1"><Button className="w-full" data-testid={`run-tree-${t.id}`}><Play className="mr-1 h-4 w-4" />Run</Button></Link>
                {isStaff && <Link to={`/trees/${t.id}/edit`}><Button variant="outline" size="icon" className="hover:text-white" data-testid={`edit-tree-${t.id}`}><Pencil className="h-4 w-4" /></Button></Link>}
              </div>
            </div>
          ))}
        </div>
      )}
      <GenerateDialog open={gen} onOpenChange={setGen} />
    </div>
  );
}
