import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { ChannelTag, Empty, PageHeader, ScoreBadge, fmtDate } from "@/components/common";

const TABS = [{ v: "open", l: "Open" }, { v: "resolved", l: "Resolved" }, { v: "", l: "All" }];

export default function Disputes() {
  const api = useApi();
  const { isStaff } = useMe();
  const [status, setStatus] = useState("open");
  const [items, setItems] = useState(null);
  useEffect(() => { setItems(null); api.get("/disputes", { params: { status } }).then((r) => setItems(r.data)); }, [api, status]);
  return (
    <div>
      <PageHeader eyebrow="Calibration" title="Score Disputes" desc={isStaff ? "Agents' challenges to AutoQA scores. Open one to review the call and settle it." : "Scores you've challenged and their outcome. Raise a dispute from any of your scored interactions."} />
      <div className="mb-4 flex gap-2">
        {TABS.map((t) => (
          <button key={t.v} onClick={() => setStatus(t.v)} data-testid={`disputes-tab-${t.v || "all"}`}
            className={`rounded-full border px-3 py-1 text-xs ${status === t.v ? "border-[#1B3F94] bg-[#1B3F94] text-white" : "border-slate-200 text-slate-500 hover:text-[#1B3F94]"}`}>{t.l}</button>
        ))}
      </div>
      {items === null ? <div className="label-mono">Loading…</div> : items.length === 0 ? <Empty testId="disputes-empty" text="No disputes here." /> : (
        <div className="space-y-3">
          {items.map((i) => (
            <Link key={i.id} to={`/interactions/${i.id}`} className="card-surface card-hover flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" data-testid={`dispute-row-${i.id}`}>
              <div>
                <div className="flex items-center gap-3"><span className="font-semibold text-[#16357F]">{i.agent_name}</span><ChannelTag channel={i.channel} /></div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-600">“{i.dispute.reason}”</p>
                <div className="mt-1 text-xs text-slate-400">Raised {fmtDate(i.dispute.raised_at)}{i.dispute.resolved_by_name && ` · settled by ${i.dispute.resolved_by_name}`}</div>
              </div>
              <div className="flex items-center gap-4">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${i.dispute.status === "open" ? "bg-amber-100 text-amber-800" : i.dispute.decision === "accepted" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                  {i.dispute.status === "open" ? "Open" : i.dispute.decision}</span>
                <ScoreBadge score={i.overall_score} autoFailed={i.auto_failed} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
