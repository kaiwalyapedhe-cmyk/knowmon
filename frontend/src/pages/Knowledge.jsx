import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { Plus, Search, Eye, ListOrdered } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { AskAI } from "@/components/AskAI";
import { Empty, PageHeader } from "@/components/common";

export default function Knowledge() {
  const api = useApi();
  const nav = useNavigate();
  const { getToken } = useAuth();
  const { isStaff } = useMe();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState(null);
  useEffect(() => { api.get("/kb/categories").then((r) => setCats(r.data)); }, [api]);
  useEffect(() => {
    const t = setTimeout(() => api.get("/kb/articles", { params: { q, category: cat } }).then((r) => setItems(r.data)), 350);
    return () => clearTimeout(t);
  }, [api, q, cat]);

  return (
    <div>
      <PageHeader eyebrow="Single source of truth" title="Knowledge Hub" desc="Search SOPs and visual guides, or ask AI for a cited answer while you're on a call.">
        {isStaff && <Button onClick={() => nav("/knowledge/new")} data-testid="new-article-btn"><Plus className="mr-1 h-4 w-4" />New article</Button>}
      </PageHeader>
      <AskAI path="/kb/ask" getToken={getToken} linkBase="/knowledge" placeholder="Ask anything, e.g. ‘Customer bought 45 days ago and wants a refund’" />
      <div className="mt-8 grid gap-6 lg:grid-cols-12">
        <aside className="lg:col-span-3">
          <div className="label-mono mb-3">Categories</div>
          <div className="flex flex-wrap gap-1 lg:flex-col">
            {["", ...cats].map((c) => (
              <button key={c || "all"} onClick={() => setCat(c)} data-testid={`kb-category-${c || "all"}`}
                className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${cat === c ? "bg-blue-500/15 text-blue-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}>{c || "All articles"}</button>
            ))}
          </div>
        </aside>
        <div className="lg:col-span-9">
          <div className="relative mb-4"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search articles, steps and tags…" className="pl-9" data-testid="kb-search-input" /></div>
          {items === null ? <div className="label-mono">Loading…</div> : items.length === 0 ? <Empty testId="kb-empty" text="No articles match." /> : (
            <div className="grid gap-4 md:grid-cols-2">
              {items.map((a) => (
                <Link key={a.id} to={`/knowledge/${a.id}`} className="card-surface card-hover block p-6" data-testid={`article-card-${a.id}`}>
                  <div className="label-mono mb-2 text-cyan-400">{a.category}</div>
                  <h3 className="text-lg font-semibold">{a.title}</h3>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-400">{a.summary || a.content}</p>
                  <div className="mt-4 flex gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{a.views}</span>
                    {a.steps?.length > 0 && <span className="flex items-center gap-1"><ListOrdered className="h-3 w-3" />{a.steps.length}-step guide</span>}
                    {a.self_service && <span className="text-emerald-400">Self-service</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
