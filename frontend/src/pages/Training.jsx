import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GraduationCap, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Empty, PageHeader, fmtDate, scoreColor } from "@/components/common";

export default function Training() {
  const api = useApi();
  const nav = useNavigate();
  const { isStaff } = useMe();
  const [courses, setCourses] = useState(null);
  const [attempts, setAttempts] = useState([]);
  useEffect(() => {
    api.get("/courses").then((r) => setCourses(r.data));
    api.get("/attempts").then((r) => setAttempts(r.data));
  }, [api]);

  return (
    <div>
      <PageHeader eyebrow="Learning management" title="Training" desc="Onboarding courses linked to the knowledge base, with built-in assessments.">
        {isStaff && <Button onClick={() => nav("/training/new")} data-testid="new-course-btn"><Plus className="mr-1 h-4 w-4" />New course</Button>}
      </PageHeader>
      {courses === null ? <div className="label-mono">Loading…</div> : courses.length === 0 ? <Empty testId="courses-empty" text="No courses yet." /> : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((c) => (
            <Link key={c.id} to={`/training/${c.id}`} className="card-surface card-hover block p-6" data-testid={`course-card-${c.id}`}>
              <GraduationCap className="mb-4 h-5 w-5 text-amber-400" />
              <div className="label-mono mb-1">{c.category}</div>
              <h3 className="text-lg font-semibold">{c.title}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-slate-400">{c.description}</p>
              <div className="mt-4 flex justify-between font-mono text-xs text-slate-500">
                <span>{c.lessons.length} lessons · {c.quiz.length} questions</span>
                {c.my_best != null && <span className={scoreColor(c.my_best)} data-testid={`course-best-${c.id}`}>best {c.my_best}%</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="card-surface mt-8 overflow-x-auto p-6">
        <div className="label-mono mb-4">{isStaff ? "Team assessment results" : "My assessment history"}</div>
        <table className="w-full min-w-[520px] text-sm" data-testid="attempts-table">
          <thead><tr className="label-mono text-left"><th className="pb-3">Learner</th><th className="pb-3">Course</th><th className="pb-3">Date</th><th className="pb-3 text-right">Score</th></tr></thead>
          <tbody>
            {attempts.length === 0 && <tr><td colSpan={4} className="py-4 text-slate-500">No attempts yet.</td></tr>}
            {attempts.map((a) => (
              <tr key={a.id} className="border-t border-white/5"><td className="py-2.5">{a.user_name}</td><td className="py-2.5 text-slate-300">{a.course_title}</td><td className="py-2.5 text-xs text-slate-500">{fmtDate(a.at)}</td>
                <td className="py-2.5 text-right"><span className={`font-mono ${scoreColor(a.score)}`}>{a.score}%</span> {a.passed ? <span className="text-xs text-emerald-400">PASS</span> : <span className="text-xs text-rose-400">FAIL</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
