import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Award, BookOpen, CheckCircle2, Loader2, Pencil, Plus, Sparkles, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Field, NativeSelect } from "@/components/common";

const blank = { title: "", description: "", category: "", pass_mark: 70, lessons: [{ title: "", content: "", article_id: "" }], quiz: [] };

function QuizRunner({ course }) {
  const api = useApi();
  const [answers, setAnswers] = useState(course.quiz.map(() => null));
  const [result, setResult] = useState(null);
  const submit = async () => {
    try { const r = await api.post(`/courses/${course.id}/attempt`, { answers }); setResult(r.data); }
    catch (e) { toast.error(errMsg(e)); }
  };
  if (!course.quiz.length) return <p className="text-sm text-slate-500">This course has no assessment yet.</p>;
  return (
    <div className="space-y-4" data-testid="quiz-runner">
      {result && (
        <div className={`rounded-lg border p-5 ${result.passed ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`} data-testid="quiz-result">
          <div className="flex items-center gap-2 text-lg font-semibold">{result.passed ? <Award className="h-5 w-5 text-emerald-600" /> : <XCircle className="h-5 w-5 text-red-600" />}
            {result.passed ? "Passed — certificate earned" : "Not passed yet"} · <span data-testid="quiz-score">{result.score}%</span> ({result.correct}/{result.total})</div>
        </div>
      )}
      {course.quiz.map((q, i) => (
        <div key={i} className="card-surface p-5" data-testid={`quiz-question-${i}`}>
          <div className="mb-3 font-medium">{i + 1}. {q.question}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {q.options.map((o, j) => {
              const rev = result?.review[i];
              const state = rev ? (j === rev.answer_index ? "border-emerald-500 bg-emerald-500/10" : j === rev.chosen ? "border-red-500 bg-red-500/10" : "border-slate-200") : answers[i] === j ? "border-[#1B3F94] bg-[#1B3F94]/15" : "border-slate-200 hover:border-slate-400";
              return <button key={j} disabled={!!result} onClick={() => setAnswers(answers.map((a, x) => (x === i ? j : a)))} data-testid={`quiz-q${i}-option-${j}`}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${state}`}>{o}</button>;
            })}
          </div>
          {result?.review[i]?.explanation && <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500"><CheckCircle2 className="mt-0.5 h-3 w-3 text-emerald-600" />{result.review[i].explanation}</p>}
        </div>
      ))}
      {result ? <Button variant="outline" className="hover:text-[#1B3F94]" onClick={() => { setResult(null); setAnswers(course.quiz.map(() => null)); }} data-testid="quiz-retake-btn">Retake</Button>
        : <Button onClick={submit} disabled={answers.some((a) => a === null)} data-testid="quiz-submit-btn">Submit answers</Button>}
    </div>
  );
}

function CourseEditor({ initial, onSave, onCancel }) {
  const api = useApi();
  const [c, setC] = useState(initial);
  const [articles, setArticles] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/kb/articles").then((r) => setArticles(r.data)); }, [api]);
  const setL = (i, k, v) => setC({ ...c, lessons: c.lessons.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const setQ = (i, k, v) => setC({ ...c, quiz: c.quiz.map((q, j) => (j === i ? { ...q, [k]: v } : q)) });
  const genQuiz = async () => {
    const linked = c.lessons.map((l) => articles.find((a) => a.id === l.article_id)?.content || "").join("\n");
    const content = c.lessons.map((l) => `${l.title}\n${l.content}`).join("\n\n") + "\n" + linked;
    setBusy(true);
    try { const r = await api.post("/courses/generate-quiz", { content, count: 5 }); setC((p) => ({ ...p, quiz: [...p.quiz, ...r.data] })); toast.success(`${r.data.length} questions added`); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4" data-testid="course-editor">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Title"><Input value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} data-testid="course-title-input" /></Field>
        <Field label="Category"><Input value={c.category} onChange={(e) => setC({ ...c, category: e.target.value })} data-testid="course-category-input" /></Field>
        <Field label="Pass mark %"><Input type="number" value={c.pass_mark} onChange={(e) => setC({ ...c, pass_mark: Number(e.target.value) })} data-testid="course-passmark-input" /></Field>
      </div>
      <Field label="Description"><Input value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} data-testid="course-desc-input" /></Field>
      <div className="label-mono">Lessons</div>
      {c.lessons.map((l, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-3" data-testid={`lesson-editor-${i}`}>
          <div className="flex gap-2"><Input placeholder="Lesson title" value={l.title} onChange={(e) => setL(i, "title", e.target.value)} data-testid={`lesson-title-${i}`} />
            <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => setC({ ...c, lessons: c.lessons.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button></div>
          <Textarea rows={3} placeholder="Lesson content" value={l.content} onChange={(e) => setL(i, "content", e.target.value)} data-testid={`lesson-content-${i}`} />
          <NativeSelect value={l.article_id} onChange={(v) => setL(i, "article_id", v)} testId={`lesson-article-${i}`} options={[{ value: "", label: "Link a knowledge article (optional)" }, ...articles.map((a) => ({ value: a.id, label: a.title }))]} />
        </div>
      ))}
      <Button variant="outline" size="sm" className="hover:text-[#1B3F94]" onClick={() => setC({ ...c, lessons: [...c.lessons, { title: "", content: "", article_id: "" }] })} data-testid="add-lesson-btn"><Plus className="mr-1 h-3 w-3" />Add lesson</Button>
      <div className="flex items-center justify-between"><div className="label-mono">Assessment ({c.quiz.length})</div>
        <Button size="sm" variant="outline" className="hover:text-[#1B3F94]" onClick={genQuiz} disabled={busy} data-testid="generate-quiz-btn">{busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}Generate questions with AI</Button></div>
      {c.quiz.map((q, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-3" data-testid={`quiz-editor-${i}`}>
          <div className="flex gap-2"><Input value={q.question} onChange={(e) => setQ(i, "question", e.target.value)} placeholder="Question" data-testid={`quiz-editor-question-${i}`} />
            <Button size="icon" variant="ghost" className="hover:text-[#1B3F94]" onClick={() => setC({ ...c, quiz: c.quiz.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button></div>
          {q.options.map((o, j) => (
            <div key={j} className="flex items-center gap-2"><input type="radio" checked={q.answer_index === j} onChange={() => setQ(i, "answer_index", j)} data-testid={`quiz-editor-${i}-correct-${j}`} />
              <Input value={o} onChange={(e) => setQ(i, "options", q.options.map((x, y) => (y === j ? e.target.value : x)))} /></div>
          ))}
          <Input value={q.explanation} onChange={(e) => setQ(i, "explanation", e.target.value)} placeholder="Explanation" />
        </div>
      ))}
      <Button variant="outline" size="sm" className="hover:text-[#1B3F94]" onClick={() => setC({ ...c, quiz: [...c.quiz, { question: "", options: ["", "", "", ""], answer_index: 0, explanation: "" }] })} data-testid="add-question-btn"><Plus className="mr-1 h-3 w-3" />Add question</Button>
      <div className="flex justify-end gap-2"><Button variant="ghost" className="hover:text-[#1B3F94]" onClick={onCancel}>Cancel</Button><Button onClick={() => onSave(c)} disabled={!c.title} data-testid="course-save-btn">Save course</Button></div>
    </div>
  );
}

export default function Course() {
  const { id } = useParams();
  const isNew = id === "new";
  const api = useApi();
  const nav = useNavigate();
  const { isStaff } = useMe();
  const [c, setC] = useState(isNew ? blank : null);
  const [editing, setEditing] = useState(isNew);
  const [lesson, setLesson] = useState(0);
  useEffect(() => { if (!isNew) api.get(`/courses/${id}`).then((r) => setC(r.data)).catch(() => setC(false)); }, [api, id, isNew]);
  const save = async (body) => {
    try {
      const r = isNew ? await api.post("/courses", body) : await api.put(`/courses/${id}`, body);
      toast.success("Course saved"); setC(r.data); setEditing(false);
      if (isNew) nav(`/training/${r.data.id}`, { replace: true });
    } catch (e) { toast.error(errMsg(e)); }
  };
  if (c === false) return <p className="text-slate-500">Course not found.</p>;
  if (!c) return <div className="label-mono">Loading…</div>;
  const l = c.lessons[lesson];
  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/training" className="mb-6 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#1B3F94]" data-testid="back-to-training"><ArrowLeft className="h-4 w-4" />Training</Link>
      {editing ? <CourseEditor initial={c} onSave={save} onCancel={() => (isNew ? nav("/training") : setEditing(false))} /> : (
        <div className="space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div><div className="label-mono mb-2">{c.category} · pass mark {c.pass_mark}%</div>
              <h1 className="text-3xl font-extrabold tracking-tight" data-testid="course-title">{c.title}</h1><p className="mt-2 text-slate-500">{c.description}</p></div>
            {isStaff && <div className="flex gap-2"><Button variant="outline" className="hover:text-[#1B3F94]" onClick={() => setEditing(true)} data-testid="course-edit-btn"><Pencil className="mr-1 h-4 w-4" />Edit</Button>
              <Button variant="ghost" className="hover:text-[#1B3F94]" data-testid="course-delete-btn" onClick={async () => { if (window.confirm("Delete course?")) { await api.delete(`/courses/${id}`); nav("/training"); } }}><Trash2 className="h-4 w-4" /></Button></div>}
          </div>
          {c.lessons.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-12">
              <div className="flex gap-1 overflow-x-auto lg:col-span-4 lg:flex-col">
                {c.lessons.map((x, i) => <button key={i} onClick={() => setLesson(i)} data-testid={`lesson-tab-${i}`} className={`shrink-0 rounded-md px-3 py-2 text-left text-sm ${i === lesson ? "bg-amber-500/15 text-amber-800" : "text-slate-500 hover:bg-slate-100 hover:text-[#1B3F94]"}`}>{i + 1}. {x.title}</button>)}
              </div>
              <div className="card-surface p-6 lg:col-span-8" data-testid="lesson-content">
                <h3 className="text-xl font-semibold">{l.title}</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{l.content}</p>
                {l.article_id && <Link to={`/knowledge/${l.article_id}`} className="mt-4 inline-flex items-center gap-1 text-sm text-[#1B3F94] hover:text-[#1B3F94]"><BookOpen className="h-4 w-4" />Open linked knowledge article</Link>}
              </div>
            </div>
          )}
          <div><h2 className="mb-4 text-xl font-bold">Assessment</h2><QuizRunner course={c} /></div>
        </div>
      )}
    </div>
  );
}
