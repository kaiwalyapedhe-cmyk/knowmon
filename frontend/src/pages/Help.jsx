import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import axios from "axios";
import { ArrowLeft, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { API } from "@/lib/api";
import { AskAI } from "@/components/AskAI";
import { StepGuide } from "@/components/StepGuide";

function ArticleView({ id }) {
  const [a, setA] = useState(null);
  useEffect(() => { axios.get(`${API}/public/kb/${id}`).then((r) => setA(r.data)).catch(() => setA(false)); }, [id]);
  if (a === false) return <p className="text-slate-500">Article not found.</p>;
  if (!a) return <div className="label-mono">Loading…</div>;
  return (
    <article className="space-y-6 fade-up">
      <Link to="/help" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#1B3F94]" data-testid="help-back-link"><ArrowLeft className="h-4 w-4" />All help articles</Link>
      <div><div className="label-mono mb-2 text-[#E31E24]">{a.category}</div><h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl" data-testid="help-article-title">{a.title}</h1></div>
      {a.content && <div className="card-surface whitespace-pre-wrap p-6 text-sm leading-relaxed text-slate-700">{a.content}</div>}
      <StepGuide steps={a.steps} />
    </article>
  );
}

export default function Help() {
  const { id } = useParams();
  const [q, setQ] = useState("");
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (id) return;
    const t = setTimeout(() => axios.get(`${API}/public/kb`, { params: { q } }).then((r) => setItems(r.data)), 300);
    return () => clearTimeout(t);
  }, [q, id]);
  return (
    <div className="grid-bg min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <Link to="/help" className="font-display text-xl font-extrabold">Help <span className="text-[#1B3F94]">Centre</span></Link>
        <span className="label-mono">Self-service</span>
      </header>
      <main className="mx-auto max-w-5xl px-6 pb-20">
        {id ? <ArticleView id={id} /> : (
          <div className="space-y-8">
            <div className="pt-8 fade-up"><h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">How can we help?</h1>
              <p className="mt-3 text-slate-500">Ask our assistant or browse step-by-step guides.</p></div>
            <AskAI path="/public/ask" linkBase="/help" placeholder="e.g. How do I reset my password?" />
            <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help articles" className="pl-9" data-testid="help-search-input" /></div>
            <div className="grid gap-4 md:grid-cols-2">
              {items.map((a) => (
                <Link key={a.id} to={`/help/${a.id}`} className="card-surface card-hover block p-6" data-testid={`help-article-${a.id}`}>
                  <div className="label-mono mb-2 text-[#E31E24]">{a.category}</div><h3 className="text-lg font-semibold">{a.title}</h3>
                  <p className="mt-1 text-sm text-slate-500">{a.summary}</p>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
