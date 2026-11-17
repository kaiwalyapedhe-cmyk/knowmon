import { useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { streamSSE } from "@/lib/api";

export function AskAI({ path, getToken, linkBase, placeholder }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true); setAnswer(""); setSources([]); setError("");
    try {
      const token = getToken ? await getToken() : null;
      await streamSSE(path, { question: q }, token, (ev) => {
        if (ev.type === "sources") setSources(ev.sources);
        if (ev.type === "delta") setAnswer((a) => a + ev.text);
        if (ev.type === "error") setError(ev.text);
      });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="card-surface relative overflow-hidden p-6" data-testid="ask-ai-panel">
      <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-[#1B3F94]/10 blur-3xl" />
      <form onSubmit={ask} className="relative flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Sparkles className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#1B3F94]" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="h-11 pl-9" data-testid="ask-ai-input" />
        </div>
        <Button type="submit" className="h-11" disabled={busy} data-testid="ask-ai-search-button">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ask AI"}</Button>
      </form>
      {(answer || busy || error) && (
        <div className="relative mt-5 border-t border-slate-200 pt-5">
          {error && <p className="text-sm text-red-600" data-testid="ask-ai-error">{error}</p>}
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700" data-testid="ask-ai-answer">{answer || (busy && "Thinking…")}</div>
          {sources.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2" data-testid="ask-ai-sources">
              <span className="label-mono self-center">Sources</span>
              {sources.map((s) => <Link key={s.id} to={`${linkBase}/${s.id}`} className="rounded-full bg-[#1B3F94]/10 px-2.5 py-1 text-xs text-[#1B3F94] hover:text-[#1B3F94]">{s.title}</Link>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
