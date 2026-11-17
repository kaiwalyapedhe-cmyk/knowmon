import { useState } from "react";
import { NotebookPen, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { fmtDate } from "@/components/common";

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function NoteList({ notes, player, onRemove }) {
  return (
    <ul className="space-y-1.5" data-testid="self-review-notes">
      {notes.map((n, i) => (
        <li key={i} className="flex items-start gap-3 text-sm">
          <button className="w-10 shrink-0 font-mono text-xs text-[#E31E24] hover:underline" onClick={() => player.current?.seek(n.t)} data-testid={`self-note-time-${i}`}>{fmt(n.t)}</button>
          <span className="flex-1 text-slate-600">{n.text}</span>
          {onRemove && <button onClick={() => onRemove(i)} data-testid={`self-note-remove-${i}`}><Trash2 className="h-3.5 w-3.5 text-slate-400 hover:text-[#E31E24]" /></button>}
        </li>
      ))}
    </ul>
  );
}

export function SelfReviewPanel({ it, player, onSaved }) {
  const api = useApi();
  const { me } = useMe();
  const own = it.agent_id === me.user_id;
  const saved = it.self_review;
  const [reflection, setReflection] = useState(saved?.reflection || "");
  const [notes, setNotes] = useState(saved?.notes || []);
  const [text, setText] = useState("");
  if (!own && !saved) return null;

  const addNote = () => {
    if (!text.trim()) return;
    setNotes([...notes, { t: Math.round((player.current?.getTime() || 0) * 10) / 10, text: text.trim() }].sort((a, b) => a.t - b.t));
    setText("");
  };
  const save = async () => {
    try { await api.put(`/interactions/${it.id}/self-review`, { reflection, notes }); toast.success("Self-review saved — your coach will see it"); onSaved(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="card-surface p-6" data-testid="self-review-panel">
      <div className="label-mono mb-3 flex items-center gap-2"><NotebookPen className="h-4 w-4" />{own ? "My self-review" : `${it.agent_name}'s self-review`}
        {saved && <span className="normal-case tracking-normal text-slate-400">· updated {fmtDate(saved.updated_at)}</span>}</div>
      {own ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Listen back, pause where something matters and add a note at that moment. Your coach sees this before your session.</p>
          <NoteList notes={notes} player={player} onRemove={(i) => setNotes(notes.filter((_, j) => j !== i))} />
          <div className="flex gap-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} placeholder="Note at current playback time…" data-testid="self-note-input" />
            <Button variant="outline" className="shrink-0 hover:text-[#1B3F94]" onClick={addNote} data-testid="self-note-add-btn"><Plus className="mr-1 h-4 w-4" />Add at time</Button>
          </div>
          <Textarea rows={3} value={reflection} onChange={(e) => setReflection(e.target.value)} placeholder="Overall: what went well, what would you do differently?" data-testid="self-review-reflection-input" />
          <Button onClick={save} disabled={!reflection.trim() && !notes.length} data-testid="self-review-save-btn">Save self-review</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {saved.reflection && <p className="whitespace-pre-wrap text-sm text-slate-600" data-testid="self-review-reflection">“{saved.reflection}”</p>}
          <NoteList notes={saved.notes} player={player} />
        </div>
      )}
    </div>
  );
}
