import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { PageHeader, ScoreBadge } from "@/components/common";

const SENT_COLORS = { positive: "#1B3F94", neutral: "#94A3B8", negative: "#E31E24" };
const tip = { contentStyle: { background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 12 } };

function Kpi({ label, value, sub, testId, accent = "text-slate-900" }) {
  return (
    <div className="card-surface card-hover p-6 fade-up">
      <div className="label-mono">{label}</div>
      <div data-testid={testId} className={`mt-3 font-display text-3xl font-bold ${accent}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function Panel({ title, children, className = "" }) {
  return (
    <div className={`card-surface p-6 ${className}`}>
      <div className="label-mono mb-4">{title}</div>
      {children}
    </div>
  );
}

export default function Dashboard() {
  const api = useApi();
  const { isStaff } = useMe();
  const [d, setD] = useState(null);
  useEffect(() => { api.get("/dashboard").then((r) => setD(r.data)); }, [api]);
  if (!d) return <div className="label-mono">Loading dashboard…</div>;
  const k = d.kpis;
  const none = k.evaluated === 0;
  return (
    <div>
      <PageHeader eyebrow="Command centre" title={isStaff ? "Quality & knowledge overview" : "My performance"}
        desc="AutoQA scores, compliance risk, sentiment, knowledge usage and training in one place." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Avg QA score" value={none ? "—" : `${k.avg_score}%`} sub={`${k.evaluated} interactions evaluated`} testId="kpi-avg-score" accent="text-[#1B3F94]" />
        <Kpi label="Compliance flag rate" value={none ? "—" : `${k.flag_rate}%`} sub={`${k.pending} awaiting AI · ${k.open_disputes} open disputes`} testId="kpi-flag-rate" accent="text-red-600" />
        <Kpi label="Predicted CSAT" value={none ? "—" : `${k.csat}/5`} sub="AI estimate from conversation" testId="kpi-csat" accent="text-emerald-600" />
        <Kpi label="Quiz pass rate" value={k.quiz_attempts ? `${k.quiz_pass_rate}%` : "—"} sub={`${k.quiz_attempts} attempts · ${k.open_coaching} open coaching`} testId="kpi-quiz-pass" accent="text-amber-600" />
      </div>
      {none && <div className="card-surface mt-4 p-6 text-sm text-slate-500" data-testid="dashboard-empty">No scored interactions yet. Charts appear once interactions are evaluated.</div>}
      <div className="mt-4 grid grid-cols-12 gap-4">
        <Panel title="QA score trend" className="col-span-12 lg:col-span-8">
          <div className="h-56" data-testid="chart-trend">
            <ResponsiveContainer>
              <AreaChart data={d.trend}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1B3F94" stopOpacity={0.4} /><stop offset="100%" stopColor="#1B3F94" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="date" stroke="#94A3B8" fontSize={11} tickFormatter={(v) => v.slice(5)} />
                <YAxis stroke="#94A3B8" fontSize={11} domain={[0, 100]} />
                <Tooltip {...tip} />
                <Area dataKey="score" stroke="#1B3F94" fill="url(#g)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Sentiment" className="col-span-12 lg:col-span-4">
          <div className="h-56" data-testid="chart-sentiment">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={d.sentiment} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={3}>
                  {d.sentiment.map((s) => <Cell key={s.name} fill={SENT_COLORS[s.name] || "#06B6D4"} />)}
                </Pie>
                <Tooltip {...tip} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-4 text-xs">
            {d.sentiment.map((s) => <span key={s.name} className="capitalize text-slate-500"><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: SENT_COLORS[s.name] }} />{s.name} {s.value}</span>)}
          </div>
        </Panel>
        <Panel title={isStaff ? "Agent leaderboard" : "My scores"} className="col-span-12 lg:col-span-7">
          <table className="w-full text-sm" data-testid="leaderboard-table">
            <thead><tr className="text-left label-mono"><th className="pb-3">#</th><th className="pb-3">Agent</th><th className="pb-3">Evals</th><th className="pb-3">Flags</th><th className="pb-3 text-right">Avg</th></tr></thead>
            <tbody>
              {d.leaderboard.map((a, i) => (
                <tr key={a.agent_name} className="border-t border-slate-200" data-testid={`leaderboard-row-${i}`}>
                  <td className="py-3 font-mono text-slate-500">{String(i + 1).padStart(2, "0")}</td>
                  <td className="py-3 font-medium">{a.agent_name}</td>
                  <td className="py-3 text-slate-500">{a.count}</td>
                  <td className="py-3">{a.flags + a.auto_fails > 0 ? <span className="text-red-600">{a.flags + a.auto_fails}</span> : <span className="text-slate-500">0</span>}</td>
                  <td className="py-3 text-right"><ScoreBadge score={a.avg_score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Criteria performance" className="col-span-12 lg:col-span-5">
          <div className="h-64" data-testid="chart-criteria">
            <ResponsiveContainer>
              <BarChart data={d.criteria} layout="vertical" margin={{ left: 10 }}>
                <XAxis type="number" domain={[0, 100]} stroke="#94A3B8" fontSize={11} />
                <YAxis type="category" dataKey="name" width={130} stroke="#94A3B8" fontSize={11} />
                <Tooltip {...tip} cursor={{ fill: "rgba(27,63,148,.05)" }} />
                <Bar dataKey="score" fill="#E31E24" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Most viewed knowledge" className="col-span-12 md:col-span-6">
          <ul className="space-y-2 text-sm">
            {d.top_articles.map((a) => (
              <li key={a.id} className="flex justify-between"><Link to={`/knowledge/${a.id}`} className="text-slate-700 hover:text-[#1B3F94]">{a.title}</Link><span className="font-mono text-xs text-slate-500">{a.views} views</span></li>
            ))}
          </ul>
        </Panel>
        <Panel title={isStaff ? "Top agent searches" : "Channels"} className="col-span-12 md:col-span-6">
          <ul className="space-y-2 text-sm" data-testid="top-searches">
            {isStaff
              ? (d.top_searches.length ? d.top_searches.map((s) => <li key={s.q} className="flex justify-between"><span className="truncate text-slate-700">"{s.q}"</span><span className="font-mono text-xs text-slate-500">{s.count}×</span></li>) : <li className="text-slate-500">No searches yet</li>)
              : d.channels.map((c) => <li key={c.name} className="flex justify-between capitalize"><span>{c.name}</span><span className="font-mono text-xs">{c.value}</span></li>)}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
